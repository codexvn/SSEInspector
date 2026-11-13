/**
 * retention.ts 与轮转 store 层测试。
 *
 * 覆盖：配置校验纯函数（未启用允许 0、启用时必填正整数且保留量小于触发
 * 阈值）、shouldRotate 边界（恰好等于阈值不触发）、retention.json 落盘与
 * 读回、临时库内 getOldestRequests 的最老排序与全字段导出、deleteRequests
 * 对 tool_calls 的级联删除与剩余条数。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setConfig } from '../src/config';
import { ApiEndpoint, ApiType, type RecordedRequest } from '../src/types';
import {
  ARCHIVE_FILE_PATTERN,
  buildArchiveFileName,
  getRetentionConfig,
  initRetention,
  replaceRetentionConfig,
  retentionArchiveDir,
  shouldRotate,
  validateRetentionConfig,
} from '../src/retention';

async function main(): Promise<void> {
  // ---- 归档命名单一来源：构造的文件名必须能被白名单模式放行（Worker 归档与主线程下载共用该模式）----
  const sample = buildArchiveFileName(new Date('2026-11-14T01:23:45'));
  assert.equal(sample, 'archive-20261114-012345.json');
  assert.ok(ARCHIVE_FILE_PATTERN.test(sample), '构造的归档文件名必须匹配白名单模式');
  assert.ok(!ARCHIVE_FILE_PATTERN.test('../archive-20261114-012345.json'), '白名单必须拒绝路径穿越');
  assert.ok(!ARCHIVE_FILE_PATTERN.test('archive-20261114-012345.json.txt'), '白名单必须拒绝附加扩展名');
  assert.ok(retentionArchiveDir().endsWith('retention-archive'));

  // ---- validateRetentionConfig ----
  assert.ok(validateRetentionConfig({ enabled: false, triggerCount: 0, keepCount: 0 }).ok);
  assert.ok(validateRetentionConfig({ enabled: false }).ok);
  const enabled = validateRetentionConfig({ enabled: true, triggerCount: 1000, keepCount: 800 });
  assert.ok(enabled.ok);
  if (enabled.ok) assert.deepEqual(enabled.config, { enabled: true, triggerCount: 1000, keepCount: 800 });
  assert.ok(!validateRetentionConfig({ enabled: true, triggerCount: 0, keepCount: 800 }).ok, '启用时触发阈值必填正整数');
  assert.ok(!validateRetentionConfig({ enabled: true, triggerCount: 1000, keepCount: 0 }).ok, '启用时保留量必填正整数');
  assert.ok(!validateRetentionConfig({ enabled: true, triggerCount: 800, keepCount: 800 }).ok, '保留量必须小于触发阈值');
  assert.ok(!validateRetentionConfig({ enabled: 'yes', triggerCount: 1, keepCount: 1 }).ok, 'enabled 必须是布尔值');
  assert.ok(!validateRetentionConfig(42).ok);

  // ---- shouldRotate：边界与算术 ----
  const conf = { enabled: true, triggerCount: 1000, keepCount: 800 };
  assert.deepEqual(shouldRotate(999, conf), { rotate: false, toDelete: 0 });
  assert.deepEqual(shouldRotate(1000, conf), { rotate: false, toDelete: 0 }, '恰好等于阈值不触发');
  assert.deepEqual(shouldRotate(1001, conf), { rotate: true, toDelete: 201 });
  assert.deepEqual(shouldRotate(1200, { ...conf, enabled: false }), { rotate: false, toDelete: 0 });

  // ---- retention.json 文件生命周期 ----
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-retention-'));
  try {
    const retentionFile = path.join(tempDir, 'retention.json');
    initRetention({ filePath: retentionFile });
    assert.deepEqual(getRetentionConfig(), { enabled: false, triggerCount: 0, keepCount: 0 }, '无文件视为未启用');

    replaceRetentionConfig({ enabled: true, triggerCount: 500, keepCount: 400 });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(retentionFile, 'utf8')),
      { enabled: true, triggerCount: 500, keepCount: 400 },
    );
    initRetention({ filePath: retentionFile });
    assert.deepEqual(getRetentionConfig(), { enabled: true, triggerCount: 500, keepCount: 400 });
    assert.throws(() => replaceRetentionConfig({ enabled: true, triggerCount: 400, keepCount: 500 }), /校验失败/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  // ---- store 层：临时库内的导出与删除 ----
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-retention-db-'));
  // 导入与配置放在 try 外：finally 需要引用 dbModule 做连接清理
  const dbPath = path.join(dbDir, 'test.db');
  setConfig({ upstreamUrl: 'http://upstream.test', port: 0, dbPath });
  const dbModule = await import('../src/db');
  const store = await import('../src/store');
  const { ToolCall } = await import('../src/entity/ToolCall');
  try {
    await dbModule.initDb();

    const base = Date.parse('2026-11-14T00:00:00Z');
    for (let i = 1; i <= 12; i++) {
      const record: RecordedRequest = {
        id: `r${String(i).padStart(2, '0')}`,
        timestamp: new Date(base + i * 1000).toISOString(),
        method: 'POST',
        path: `/v1/chat/completions`,
        upstreamUrl: `http://upstream.test/v1/chat/completions`,
        requestHeaders: {},
        requestBody: { model: 'm', messages: [{ role: 'user', content: `msg-${i}` }] },
        responseStatus: 200,
        responseContent: null,
        responseBody: `{"n":${i}}`,
        streaming: false,
        durationMs: 10,
        apiType: ApiType.OpenAI,
        apiEndpoint: ApiEndpoint.OpenAIChat,
        state: 'done',
        finished: 'ok',
      };
      await store.upsertRecord(record);
    }
    assert.equal((await store.getStats()).total, 12);

    // 给最老的两条挂 tool_calls，验证级联删除
    const toolRepo = dbModule.AppDataSource.getRepository(ToolCall);
    await toolRepo.save([
      { request_id: 'r01', tool_call_id: 'tc-1', tool_name: 'demo', created_at: new Date().toISOString() },
      { request_id: 'r02', tool_call_id: 'tc-2', tool_name: 'demo', created_at: new Date().toISOString() },
    ]);
    assert.equal(await toolRepo.count(), 2);

    // 决策算术与导出：trigger=10 / keep=7 → 待删 5 条最老
    const decision = shouldRotate(12, { enabled: true, triggerCount: 10, keepCount: 7 });
    assert.deepEqual(decision, { rotate: true, toDelete: 5 });
    const { requests: oldest, toolCalls } = await store.getOldestRequests(decision.toDelete);
    assert.deepEqual(oldest.map(row => row.id), ['r01', 'r02', 'r03', 'r04', 'r05']);
    assert.equal(oldest[0].response_body, '{"n":1}', '导出保留全字段原始列');
    assert.deepEqual(toolCalls.map(row => row.request_id).sort(), ['r01', 'r02'], '导出包含关联 tool_calls');

    const deleted = await store.deleteRequests(oldest.map(row => row.id));
    assert.equal(deleted, 5);
    assert.equal((await store.getStats()).total, 7, '删除后剩余 keep 量');
    assert.equal(await toolRepo.count(), 0, 'tool_calls 级联删除');
    assert.equal(await store.deleteRequests([]), 0, '空删除清单应返回 0 而不产生 SQL');
    const remaining = await store.getAll(undefined, undefined, 'all') as Array<{ id: string }>;
    assert.ok(remaining.some(row => row.id === 'r06'), '剩余记录包含 r06');
    assert.ok(!remaining.some(row => row.id === 'r01'), '最老记录已删除');
  } finally {
    // better-sqlite3 句柄释放存在窗口期，Windows 上立即 rm 可能 EBUSY；
    // 清理失败打印原因（残留目录位于系统临时目录，由系统清理兜底）
    await dbModule.AppDataSource.destroy();
    try {
      fs.rmSync(dbDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[retention-test] 临时目录清理失败（句柄延迟释放）: ${dbDir}`, error);
    }
  }

  console.log('retention tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
