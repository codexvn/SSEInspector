import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig } from '../src/config';
import { ApiEndpoint, ApiType, type RecordedRequest } from '../src/types';

function passthroughRecord(overrides: Partial<RecordedRequest> = {}): RecordedRequest {
  return {
    id: 'pt-1',
    timestamp: new Date().toISOString(),
    method: 'GET',
    path: '/v1/models',
    upstreamUrl: 'http://upstream.test/v1/models',
    requestHeaders: { accept: 'application/json' },
    requestBody: null,
    responseStatus: 200,
    responseContent: { object: 'list', data: [] } as unknown as RecordedRequest['responseContent'],
    responseBody: '{"object":"list","data":[]}',
    streaming: false,
    durationMs: 12,
    apiType: ApiType.Passthrough,
    apiEndpoint: ApiEndpoint.Passthrough,
    state: 'done',
    finished: 'ok',
    ...overrides,
  };
}

function openaiChatRecord(id = 'ai-1'): RecordedRequest {
  return {
    id,
    timestamp: new Date(Date.now() + 1).toISOString(),
    method: 'POST',
    path: '/v1/chat/completions',
    upstreamUrl: 'http://upstream.test/v1/chat/completions',
    requestHeaders: {},
    requestBody: {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
    },
    responseStatus: 200,
    responseContent: null,
    streaming: false,
    durationMs: 5,
    apiType: ApiType.OpenAI,
    apiEndpoint: ApiEndpoint.OpenAIChat,
    state: 'done',
    finished: 'ok',
  };
}

async function main(): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'sse-inspector-passthrough-'));
  const dbPath = join(tempDir, 'test.db');
  setConfig({ upstreamUrl: 'http://upstream.test', port: 0, dbPath });

  const [{ AppDataSource, initDb }, { getAll, getById, getStats, upsertRecord }] = await Promise.all([
    import('../src/db'),
    import('../src/store'),
  ]);

  try {
    await initDb();

    await upsertRecord(passthroughRecord());

    const detail = await getById('pt-1');
    assert.equal(detail?.apiType, 'passthrough');
    assert.equal(detail?.apiEndpoint, 'passthrough');
    assert.equal(detail?.path, '/v1/models');
    assert.equal(detail?.method, 'GET');

    const page = await getAll(1, 10, 'passthrough') as {
      items: Array<{ id: string; apiType: string; apiEndpoint: string; preview: string }>;
      counts?: { openai: number; anthropic: number; passthrough: number; streaming: number; error: number };
    };
    assert.equal(typeof page, 'object');
    assert.ok(page.items.some(item => item.id === 'pt-1'));
    assert.ok((page.counts?.passthrough ?? 0) >= 1);
    assert.equal(page.items.find(item => item.id === 'pt-1')?.preview, 'GET /v1/models');

    const stats = await getStats();
    assert.ok(stats.passthrough >= 1);
    assert.equal(typeof stats.total, 'number');
    assert.equal(typeof stats.openai, 'number');
    assert.equal(typeof stats.anthropic, 'number');
    assert.equal(typeof stats.streaming, 'number');
    assert.equal(typeof stats.error, 'number');

    await upsertRecord(openaiChatRecord());

    const openaiPage = await getAll(1, 10, 'openai') as {
      items: Array<{ id: string }>;
      counts?: { openai: number; anthropic: number; passthrough: number; streaming: number; error: number };
    };
    assert.ok(openaiPage.items.some(item => item.id === 'ai-1'));
    assert.ok(!openaiPage.items.some(item => item.id === 'pt-1'));
    assert.ok((openaiPage.counts?.passthrough ?? 0) >= 1);
    assert.ok((openaiPage.counts?.openai ?? 0) >= 1);

    const passthroughOnly = await getAll(1, 10, 'passthrough') as {
      items: Array<{ id: string }>;
    };
    assert.ok(passthroughOnly.items.every(item => item.id !== 'ai-1'));
    assert.ok(passthroughOnly.items.some(item => item.id === 'pt-1'));

    // 空字符串 requestBody 不应被 falsy 丢弃（JSON.stringify 后可读回）
    await upsertRecord(passthroughRecord({
      id: 'pt-empty-str',
      requestBody: '',
    }));
    const emptyBody = await getById('pt-empty-str');
    assert.equal(emptyBody?.requestBody, '""');
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('store passthrough tests passed');
}).catch((error: unknown) => {
  console.error(`store passthrough tests failed: ${formatErrorChain(error)}`);
  process.exitCode = 1;
});

function formatErrorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current) {
    if (current instanceof Error) {
      messages.push(`${current.name}: ${current.message}`);
      current = current.cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  return messages.join(' -> ');
}
