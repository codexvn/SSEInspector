# Structured Logging and Proxy Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接入 Pino 结构化日志与彩色终端显示，为所有正常代理请求保留可关联的 start/end 日志，并为真正异常输出明确的 warning/error。

**Architecture:** `backend/src/logger.ts` 为主线程和 Recorder Worker 提供相同的 Pino child logger API；默认 pretty 彩色输出，JSON 模式可由 Collector 采集。`httpxy` 和主线程继续只处理传输生命周期，`downstream_closed` 是否语义完整仍由 Recorder Worker 根据 endpoint terminal SSE 判断。

**Tech Stack:** TypeScript、Node.js 20+、Pino 10.3.1、pino-pretty 13.1.3、httpxy、Worker Threads、node:assert、tsx

## Global Constraints

- 不修改数据库 schema、外部接口或 Recorder 消息协议。
- 不在代理主线程解析 JSON/SSE。
- 不输出请求体、响应体、headers 或认证信息。
- `pino` 与 `pino-pretty` 是本轮唯一新增依赖。
- `LOG_FORMAT` 只接受 `pretty` 或 `json`，默认 `pretty`；`LOG_LEVEL` 默认 `info`。
- 项目 `engines.node` 从 `>=18` 提升为 `>=20`。
- `backend/src` 与 `bin` 的 Node 运行时代码不得保留 `console.log/warn/error` 或第二套 logger fallback。
- CLI help 使用 `process.stdout.write()`；frontend 和 test 的 console 不属于服务日志迁移范围。
- 未经用户再次明确允许，不执行 git commit。

---

### Task 1: 建立 Pino 日志基础设施

**Files:**
- Create: `backend/src/logger.ts`
- Create: `backend/test/logger.test.ts`
- Create: `backend/test/cli-logging.test.ts`
- Modify: `bin/parse-args.js`
- Modify: `bin/sse-inspector.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `getLogger(component: string): Logger`、`serializeError(error: unknown): SerializedError`、`resolveLogConfig(env: NodeJS.ProcessEnv): LogConfig`。
- Consumes: `LOG_FORMAT`、`LOG_LEVEL` 和进程 stdout。

- [ ] **Step 1: 安装锁定版本并提升 Node floor**

Run:

```bash
npm install pino@10.3.1 pino-pretty@13.1.3
```

将 `package.json` 的 Node engine 改为：

```json
"engines": { "node": ">=20" }
```

新增脚本：

```json
"test:logger": "tsx backend/test/logger.test.ts",
"test:cli-logging": "tsx backend/test/cli-logging.test.ts"
```

并将其加入 `test:all`。

- [ ] **Step 2: 为配置、JSON、pretty 和错误链编写失败测试**

`backend/test/logger.test.ts` 使用内存 `Writable` 调用可注入 destination 的 logger factory，覆盖：

```ts
assert.deepEqual(resolveLogConfig({}), { format: 'pretty', level: 'info' })
assert.deepEqual(resolveLogConfig({ LOG_FORMAT: 'json', LOG_LEVEL: 'debug' }), { format: 'json', level: 'debug' })
assert.throws(() => resolveLogConfig({ LOG_FORMAT: 'xml' }), /LOG_FORMAT/)
assert.throws(() => resolveLogConfig({ LOG_LEVEL: 'verbose' }), /LOG_LEVEL/)
```

JSON 输出必须包含 `service=sse-inspector`、component、level、msg 和结构化字段；pretty 输出在 `colorize=true` 时必须包含 ANSI escape；`serializeError()` 必须递归保存 cause 的 type、message 和 stack。

- [ ] **Step 3: 运行测试并确认失败**

Run:

```bash
npm run test:logger
```

Expected: FAIL，因为 logger 模块尚不存在。

- [ ] **Step 4: 实现统一 logger**

`backend/src/logger.ts` 定义：

```ts
export type LogFormat = 'pretty' | 'json'

export interface LogConfig {
  format: LogFormat
  level: string
}

export interface SerializedError {
  type: string
  message: string
  stack?: string
  cause?: SerializedError
}

export function resolveLogConfig(env: NodeJS.ProcessEnv): LogConfig
export function serializeError(error: unknown): SerializedError
export function createAppLogger(config: LogConfig, options?: { destination?: NodeJS.WritableStream; colorize?: boolean }): Logger
export function getLogger(component: string): Logger
```

pretty 模式使用：

```ts
pretty({
  colorize: options.colorize ?? true,
  singleLine: true,
  levelFirst: true,
  translateTime: 'SYS:standard',
  sync: true,
})
```

JSON 模式不使用 transport 或 formatter，直接输出 Pino NDJSON。根字段固定包含 `{ service: 'sse-inspector' }`，`getLogger()` 使用 Map 缓存 `{ component }` child logger。

- [ ] **Step 5: 运行 logger 测试并确认通过**

Run:

```bash
npm run test:logger
```

Expected: PASS；JSON 可解析、pretty 有颜色、非法配置失败、Error cause 完整。

- [ ] **Step 6: 为 CLI 全量迁移编写失败测试**

`backend/test/cli-logging.test.ts` 先测试 `parseArgs()` 对未知参数返回错误而不输出，再以子进程运行构建后的 CLI：

```ts
const parsed = parseArgs(['--unknown'])
assert.deepEqual(parsed.errors, ['未知参数: --unknown'])
assert.equal(parsed.options.help, true)
```

子进程设置 `LOG_FORMAT=json`，执行：

```bash
node bin/sse-inspector.js --unknown
```

断言退出码为 1、输出中存在可解析的 Pino error record，且 `bin/parse-args.js` 和 `bin/sse-inspector.js` 不调用 console。

- [ ] **Step 7: 运行 CLI 测试并确认失败**

Run:

```bash
npm run build && npm run test:cli-logging
```

Expected: FAIL，因为 parseArgs 仍直接输出，CLI 也尚未加载 Pino。

- [ ] **Step 8: 将 CLI 参数与启动错误接入同一 logger**

`bin/parse-args.js` 改为返回：

```js
{
  options: { upstream, port, dbPath, dev, help },
  errors: string[],
}
```

并导出 `getHelpText()`；help 使用 `process.stdout.write(getHelpText())`。`bin/sse-inspector.js` 先调用纯 `parseArgs()`，随后按 `options.dev` 注册 tsx 或加载 dist，再取得：

```js
const logger = getLogger('cli')
```

所有参数校验和启动错误使用 `logger.error({ ...fields }, message)`。logger 加载失败不捕获、不 fallback，直接让 Node 以非零状态退出。

- [ ] **Step 9: 运行 logger 与 CLI 测试并确认通过**

Run:

```bash
npm run build
npm run test:logger
npm run test:cli-logging
```

Expected: PASS；CLI 错误为结构化 Pino 日志，help 保持纯文本，dev/prod 使用同一个 logger 实现。

---

### Task 2: 固定代理传输日志行为

**Files:**
- Modify: `backend/test/proxy-data-plane.test.ts`
- Modify: `backend/src/proxy.ts`

**Interfaces:**
- Consumes: 现有 `ProxyContext`、`finalizeClosed()`、`finalizeFailure()` 和 httpxy 生命周期事件。
- Produces: 带 request ID、status、duration 的 start/end/warning/error 日志；正常 `downstream_closed` 使用中性 end 文案。

- [ ] **Step 1: 为日志行为添加失败测试**

在 `backend/test/proxy-data-plane.test.ts` 中通过 `getLogger('proxy')` 取得与生产代码相同的缓存 child logger，临时替换其 `info`、`warn`、`error` 方法捕获结构化 bindings 和 message，并在 finally 中恢复。为现有 client-close 和 upload-abort 场景增加断言：

```ts
assert.ok(events.some(event => event.message === 'proxy request started' && event.fields.method === 'POST'))
assert.ok(events.some(event => event.message === 'proxy request ended' && event.fields.reason === 'upstream_complete'))
assert.ok(events.some(event => event.message === 'proxy request ended' && event.fields.reason === 'downstream_closed'))
assert.equal(events.filter(event => event.level === 'warn' && event.fields.reason === 'request_aborted').length, 1)
assert.ok(events.every(event => event.fields.requestId === undefined || typeof event.fields.requestId === 'string'))
```

测试结束和异常路径都必须恢复三个 logger 方法，避免污染其他测试。

- [ ] **Step 2: 运行代理测试并确认失败**

Run:

```bash
npm run test:proxy
```

Expected: FAIL，因为 proxy 尚未使用 Pino child logger，也没有统一 start/end 结构化事件。

- [ ] **Step 3: 为 ProxyContext 增加开始时间并统一字段**

在 `backend/src/proxy.ts` 创建请求时只读取一次时间：

```ts
const startedAt = Date.now()
```

将该值同时传给 capture metadata，并加入 `ProxyContext`：

```ts
interface ProxyContext {
  id: string | null
  startedAt: number
  // existing fields remain unchanged
}
```

新增纯字段辅助值：

```ts
function contextLogFields(context: ProxyContext, status = context.responseStatus) {
  return {
    requestId: context.id ?? undefined,
    status,
    durationMs: Date.now() - context.startedAt,
    target: context.targetLog,
  }
}
```

- [ ] **Step 4: 调整 start、close 和 failure 日志**

请求开始日志改为：

```ts
proxyLogger.info({ requestId: id ?? undefined, method: req.method, path: req.path, target: targetLog }, 'proxy request started')
```

`proxy.on('end')` 在完成 capture 前输出正常结束日志：

```ts
proxyLogger.info({ ...contextLogFields(context), reason: 'upstream_complete' }, 'proxy request ended')
```

`finalizeClosed()` 保持 socket/capture 行为不变，并按 reason 输出：

```ts
if (reason === 'request_aborted') {
  proxyLogger.warn({ ...contextLogFields(context, status), reason }, 'proxy request aborted')
} else {
  proxyLogger.info({ ...contextLogFields(context, status), reason }, 'proxy request ended')
}
```

`finalizeFailure()` 改为：

```ts
proxyLogger.error({ ...contextLogFields(context), reason, err: serializeError(error) }, 'proxy request failed')
```

- [ ] **Step 5: 运行代理测试并确认通过**

Run:

```bash
npm run test:proxy
```

Expected: PASS；正常请求均有 start/end，client-close 使用中性文案，upload-abort warning 可通过 ID 关联。

---

### Task 3: 只为真正不完整的响应输出 Recorder warning

**Files:**
- Modify: `backend/test/recorder-worker.test.ts`
- Modify: `backend/src/recorder/worker.ts`

**Interfaces:**
- Consumes: `closeCapture()` 的 terminal 判断和 `persistPartialCapture()`。
- Produces: terminal client-close 静默；非 terminal client-close 输出一次 Recorder warning。

- [ ] **Step 1: 为 Worker 语义日志添加失败测试**

将 `backend/test/recorder-worker.test.ts` 的 Worker stdout 按 NDJSON 行解析为 Pino records。创建 Worker 时显式传入 `env: { ...process.env, LOG_FORMAT: 'json', LOG_LEVEL: 'info' }`，每次 `runWorker()` 结束后增加断言：

```ts
const incomplete = workerLogs.filter(log => log.msg === 'captured response is incomplete')
assert.equal(incomplete.length, 1)
assert.equal(incomplete[0].component, 'recorder-worker')
assert.equal(incomplete[0].reason, 'downstream_closed')
assert.equal(incomplete[0].status, 200)
assert.equal(typeof incomplete[0].durationMs, 'number')
```

现有测试已经同时产生 terminal、partial、truncated 三种 client-close；预期仅 partial 输出 warning。继续保留“不出现请求体解码失败/空响应 JSON 解析失败”的断言。

- [ ] **Step 2: 运行 Worker 测试并确认失败**

Run:

```bash
npm run build && npm run test:worker
```

Expected: FAIL，因为当前 partial capture 只写数据库，没有输出语义 warning。

- [ ] **Step 3: 在非 terminal、非 truncated 路径输出 warning**

在 `persistPartialCapture()` 中，完成 duration 计算后、数据库写入前增加：

```ts
if (!state.truncated) {
  logger.warn(
    {
      requestId: state.metadata.id,
      status,
      durationMs: record.durationMs,
      reason: 'downstream_closed',
    },
    'captured response is incomplete',
  )
}
```

不得在 `persistCompletedCapture()` 输出 client-close；不得为 `persistAbortedCapture()` 重复输出 downstream warning。

- [ ] **Step 4: 运行 Worker 测试并确认通过**

Run:

```bash
npm run build && npm run test:worker
```

Expected: PASS；每个 dev/prod Worker 仅 partial client-close 输出一次 incomplete warning。

---

### Task 4: 迁移后端运行时日志

**Files:**
- Modify: `backend/src/body-decode.ts`
- Modify: `backend/src/db/index.ts`
- Modify: `backend/src/db/slow-query-logger.ts`
- Modify: `backend/src/index.ts`
- Modify: `backend/src/recorder/client.ts`
- Modify: `backend/src/recorder/worker.ts`
- Modify: `backend/src/sse-parser.ts`
- Modify: `backend/src/store.ts`
- Modify: `backend/src/stream-accumulators/anthropic.ts`
- Modify: `backend/src/stream-accumulators/openai-responses.ts`
- Modify: `bin/parse-args.js`
- Modify: `bin/sse-inspector.js`
- Test: `backend/test/db-logger.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `getLogger()` 与 `serializeError()`。
- Produces: `backend/src` 与 `bin` 中无运行时 `console.log/warn/error`。

- [ ] **Step 1: 更新慢 SQL logger 测试并确认失败**

让 `backend/test/db-logger.test.ts` 捕获 `getLogger('db').warn`，断言 bindings 为 `{ durationMs, sql }`，message 为 `slow database query`，且不包含参数或结果。

Run:

```bash
tsx backend/test/db-logger.test.ts
```

Expected: FAIL，因为 `SlowQueryLogger` 仍调用 `console.warn`。

- [ ] **Step 2: 按组件迁移所有运行时 console**

每个模块在顶层取得明确 child logger：

```ts
const logger = getLogger('db')
const logger = getLogger('api')
const logger = getLogger('recorder')
const logger = getLogger('sse-parser')
```

普通状态使用 `info`，可恢复的数据/协议异常使用 `warn`，启动失败、Worker fatal、上游异常和数据库失败使用 `error`。所有 catch 块使用：

```ts
logger.error({ err: serializeError(error), ...context }, 'operation failed')
```

删除迁移后不再使用的 `formatErrorChain()` 重复实现。`SlowQueryLogger` 使用：

```ts
dbLogger.warn({ durationMs: time, sql: query }, 'slow database query')
```

- [ ] **Step 3: 验证运行时代码没有散落 console**

Run:

```bash
rg -n "console\.(log|warn|error)" backend/src bin
```

Expected: 无匹配。frontend 和 test 文件不在此断言范围内。

- [ ] **Step 4: 运行相关测试**

Run:

```bash
npm run test:decode
npm run test:sse
npm run test:usage
npm run test:preview
npm run test:cli-logging
tsx backend/test/db-logger.test.ts
```

Expected: 全部 PASS。

---

### Task 5: 同步文档并执行完整验证

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1 和 Task 2 的最终日志语义。
- Produces: 与实现一致的代理/Recorder 日志约定。

- [ ] **Step 1: 更新架构说明**

在 `CLAUDE.md` 与 `README.md` 中说明 Pino 日志配置和代理语义：

```text
正常 upstream_complete 和 downstream_closed 均输出中性的 end 日志；request_aborted 使用 warning，
upstream_aborted/upstream_error 使用 error。缺少 terminal 的 downstream_closed 由 Recorder Worker
完成协议判断后额外输出 incomplete warning。所有日志包含 request ID，结束日志还包含 status 和 duration。

LOG_FORMAT=pretty  # 默认，彩色单行终端
LOG_FORMAT=json    # NDJSON，供 Collector/Agent 采集
LOG_LEVEL=info     # 默认 level
```

- [ ] **Step 2: 运行全量验证**

Run:

```bash
npm run test:all
.\node_modules\.bin\tsc.cmd --noEmit
.\frontend\node_modules\.bin\vue-tsc.cmd --noEmit -p frontend/tsconfig.app.json
npm run build:all
git diff --check
```

Expected: 所有命令退出码为 0；Vite 仅允许现有 chunk size warning。

- [ ] **Step 3: 提交前安全检查**

检查 diff 中无 token、密码、认证头、请求体、响应体和 `[CCGUI_DEBUG_` 临时日志。向用户报告改动和验证结果，不执行 git commit，除非用户再次明确要求。
