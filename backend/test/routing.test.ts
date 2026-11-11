/**
 * routing.ts 纯函数与文件生命周期测试。
 *
 * 覆盖：段边界前缀匹配、配置校验与规范化（含各类非法输入）、
 * initRouting 读文件与 CLI 覆盖语义、resolveUpstream 的顺序/停用/默认
 * 回退、损坏文件按空配置启动、replaceRoutingConfig 的落盘与内存交换、
 * 未显式初始化时按 CLI 单上游惰性兜底。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setConfig } from '../src/config';
import {
  initRouting,
  prefixMatches,
  replaceRoutingConfig,
  resolveUpstream,
  validateRoutingConfig,
  type PersistedRoutingConfig,
  type UpstreamRoute,
} from '../src/routing';

const tempDirs: string[] = [];

function tempRoutingPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-routing-'));
  tempDirs.push(dir);
  return path.join(dir, 'routing.json');
}

function route(partial: Partial<UpstreamRoute> & Pick<UpstreamRoute, 'prefix' | 'upstream'>): UpstreamRoute {
  return { id: crypto.randomUUID(), name: '', enabled: true, ...partial };
}

// ---- 惰性兜底：未 initRouting 时按 config.upstreamUrl 单上游语义工作 ----
setConfig({ upstreamUrl: 'http://lazy-default:1', port: 0, dbPath: 'unused.db' });
assert.deepEqual(resolveUpstream('/v1/chat/completions'), {
  upstream: 'http://lazy-default:1',
  source: 'default',
  routeName: '',
});

// ---- prefixMatches：段边界语义 ----
assert.equal(prefixMatches('/', '/anything/else'), true);
assert.equal(prefixMatches('/v1', '/v1'), true);
assert.equal(prefixMatches('/v1', '/v1/chat/completions'), true);
assert.equal(prefixMatches('/v1', '/v1foo'), false);
assert.equal(prefixMatches('/v1', '/v2/chat'), false);

// ---- validateRoutingConfig：规范化与错误清单 ----
const ok = validateRoutingConfig({
  defaultUpstream: 'http://a:8000/',
  routes: [
    { id: 'r1', name: 'beta', enabled: true, prefix: 'beta/', upstream: 'https://b.example:9443/' },
    { id: 'r2', name: '路径前缀', enabled: false, prefix: '/v1', upstream: 'http://c/base/' },
  ],
});
assert.ok(ok.ok);
if (ok.ok) {
  assert.equal(ok.config.defaultUpstream, 'http://a:8000');
  assert.equal(ok.config.routes[0].prefix, '/beta');
  assert.equal(ok.config.routes[0].upstream, 'https://b.example:9443');
  // 路径前缀与 CLI --upstream 拼接语义一致，保留并去尾斜杠
  assert.equal(ok.config.routes[1].upstream, 'http://c/base');
  assert.equal(ok.config.routes[1].enabled, false);
}

const bad = validateRoutingConfig({
  defaultUpstream: 'http://a:8000/base?x=1',
  routes: [
    { id: 'x', name: '', enabled: true, prefix: '/a?b', upstream: 'ftp://c' },
    { id: 'x', name: '', enabled: 'yes', prefix: '', upstream: '' },
  ],
});
assert.ok(!bad.ok);
if (!bad.ok) {
  // 默认上游带 query；首条前缀含 ?、上游为非法协议；次条 id 重复、enabled 类型错、空前缀、空上游
  assert.equal(bad.errors.length, 7);
}
assert.ok(!validateRoutingConfig('nope').ok);
assert.ok(!validateRoutingConfig({ routes: 'not-array' }).ok);

// ---- initRouting：读文件 + CLI 覆盖 + resolveUpstream 语义 ----
const fileA = tempRoutingPath();
fs.writeFileSync(fileA, JSON.stringify({
  defaultUpstream: 'http://persisted:2',
  routes: [
    { id: 'a', name: '前缀A', enabled: true, prefix: '/alpha', upstream: 'http://alpha:3' },
    { id: 'b', name: '停用', enabled: false, prefix: '/v1', upstream: 'http://disabled:4' },
    { id: 'c', name: '', enabled: true, prefix: '/v1', upstream: 'http://v1:5' },
  ],
} satisfies PersistedRoutingConfig));

initRouting({ cliUpstream: 'http://cli:6', filePath: fileA });
// CLI 覆盖持久默认值（effectiveDefault 取 CLI，persistedDefault 保留）
assert.equal(resolveUpstream('/unknown')!.upstream, 'http://cli:6');
// 顺序优先：/alpha 命中第一条；停用规则跳过，/v1 命中启用中的那条
assert.deepEqual(resolveUpstream('/alpha/x'), { upstream: 'http://alpha:3', source: 'route', routeName: '前缀A' });
assert.equal(resolveUpstream('/v1/chat').upstream, 'http://v1:5');
// 段边界：/alphax 不命中 /alpha，回落默认
assert.equal(resolveUpstream('/alphax').source, 'default');

initRouting({ cliUpstream: null, filePath: fileA });
assert.equal(resolveUpstream('/unknown')!.upstream, 'http://persisted:2');

// ---- 损坏文件与缺失文件：按空配置启动 ----
const fileCorrupt = tempRoutingPath();
fs.writeFileSync(fileCorrupt, '{not json');
initRouting({ cliUpstream: null, filePath: fileCorrupt });
assert.equal(resolveUpstream('/x'), null);

const missingFile = path.join(path.dirname(tempRoutingPath()), 'missing.json');
initRouting({ cliUpstream: null, filePath: missingFile });
assert.equal(resolveUpstream('/x'), null);

// ---- replaceRoutingConfig：落盘 + 内存交换 + 非法输入拒绝 ----
const fileB = tempRoutingPath();
initRouting({ cliUpstream: 'http://cli:6', filePath: fileB });
const next: PersistedRoutingConfig = {
  defaultUpstream: null,
  routes: [route({ name: '仅规则', prefix: '/only', upstream: 'http://only:7' })],
};
replaceRoutingConfig(next);
// 命中规则生效；未命中且无默认（CLI 覆盖仍为 cli:6 → 有默认）——先验证规则
assert.equal(resolveUpstream('/only/x')!.upstream, 'http://only:7');
// 重新从同一文件初始化：落盘内容可读回（CLI 置空后仅剩规则，默认为 null）
initRouting({ cliUpstream: null, filePath: fileB });
assert.equal(resolveUpstream('/only')!.upstream, 'http://only:7');
assert.equal(resolveUpstream('/other'), null);
// 写出的文件内容与配置一致
const persisted = JSON.parse(fs.readFileSync(fileB, 'utf8'));
assert.equal(persisted.routes.length, 1);
assert.equal(persisted.defaultUpstream, null);
// 非法配置抛出且不落盘、不换内存
assert.throws(() => replaceRoutingConfig({ defaultUpstream: 'notaurl', routes: [] }));
assert.equal(resolveUpstream('/only')!.upstream, 'http://only:7');

// ---- initRouting 的 CLI 上游校验：非法值抛错，路径前缀规范化 ----
assert.throws(() => initRouting({ cliUpstream: 'garbage', filePath: fileB }), /--upstream/);
initRouting({ cliUpstream: 'http://cli:9/base/', filePath: fileB });
assert.equal(resolveUpstream('/any/x')!.upstream, 'http://cli:9/base');

// ---- 清理临时目录 ----
for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });

console.log('routing tests passed');
