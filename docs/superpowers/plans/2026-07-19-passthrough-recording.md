# 透传请求记录与筛选 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对全部透传流量统一 capture 并落库，提供独立「透传」筛选与 raw 向详情；取消 64 MiB 积压截断，保留 1 MiB drain。

**Architecture:** 数据面让 `handlePassthrough` 与 AI 共用同一 capture 管线并生成 UUID；语义面用 `ApiType/ApiEndpoint = passthrough` 短路 `resolveEndpoint`、SSE merge、tool pairing 与 usage。store 以 `api_endpoint` 列为读路径事实源；capture 队列删除 truncate，仅保留每轮 1 MiB drain。

**Tech Stack:** TypeScript、Express、httpxy、Worker Threads、TypeORM/SQLite、Vue 3、Pinia、node:assert、tsx

**Spec:** [docs/superpowers/specs/2026-07-19-passthrough-recording-design.md](../specs/2026-07-19-passthrough-recording-design.md)

## Global Constraints

- 主线程不解析 JSON/SSE、不访问数据库。
- `httpxy` 仍是 proxy pipe / 背压 / 销毁的唯一所有者；禁止 `selfHandleResponse` 或手写转发循环。
- 透传不做协议 merge / tool pairing / usage；未知 path 不得回退 Chat。
- 类型用 `as const` 对象 + 联合类型，不用 TypeScript `enum`。
- 运行时比较优先 `ApiType.Passthrough` 等常量；经 `resolveRecordIdentity` 单一入口。
- truncate 管线整条删除，不是 disable；保留 `MAX_CAPTURE_DRAIN_BYTES = 1 MiB`。
- schema 不兼容时删旧 DB 重建，不写 migration。
- UI 文案/注释/文档：简体中文；标识符：英文。
- **未经用户明确允许，不得 `git commit`**。计划中的 Commit 步骤仅在用户授权后执行；默认可跳过并继续下一 task。
- 提交信息若授权：Conventional Commits + 简体中文，本项目无需任务卡片号。

## File Structure

| 文件 | 职责 |
|------|------|
| `backend/src/types.ts` | `ApiType` / `ApiEndpoint` / `RequestListFilter` 常量 + 联合类型 |
| `backend/src/record-identity.ts`（新建） | `resolveRecordIdentity` 单一身份入口 |
| `backend/src/entity/RequestEntity.ts` | 新增 `api_endpoint` 列 |
| `backend/src/store.ts` | 透传读写、preview、filter、stats/counts |
| `backend/src/body-decode.ts` | 请求体解码：JSON 失败时 UTF-8 文本回退（供检查器） |
| `backend/src/recorder/protocol.ts` | 删除 `capture.truncated`；metadata 类型跟新 |
| `backend/src/recorder/capture-queue.ts` | 去掉 maxPending/truncate |
| `backend/src/recorder/client.ts` | 去掉 truncate 状态与协议发送 |
| `backend/src/recorder/worker.ts` | 透传短路 merge/tools/usage/terminal |
| `backend/src/proxy.ts` | 透传也 UUID + beginCapture |
| `backend/src/index.ts` | `parseRequestListFilter` 接受 `passthrough` |
| `frontend/src/types.ts` | 镜像常量与类型 |
| `frontend/src/stores/requests.ts` | counts + filter 匹配 |
| `frontend/src/views/ListView.vue` | 顶栏顺序 A + 透传徽章 |
| `frontend/src/views/DetailView.vue` | 透传 raw 布局 |
| `frontend/src/App.vue`（若含 badge 全局样式） | `badge-passthrough` |
| `CLAUDE.md` | 文档同步 |
| 测试 | 见各 task |

---

### Task 1: 类型常量与记录身份解析

**Files:**
- Modify: `backend/src/types.ts`
- Create: `backend/src/record-identity.ts`
- Create: `backend/test/record-identity.test.ts`
- Modify: `package.json`（`test:identity` 脚本并加入 `test:all`）

**Interfaces:**
- Produces:
  - `ApiType` / `ApiEndpoint` / `RequestListFilter` 常量对象与派生联合类型
  - `resolveRecordIdentity(input: { path: string; apiType: ApiType; apiEndpoint: ApiEndpoint }): { kind: 'ai' | 'passthrough'; provider: ApiType; endpoint: ApiEndpoint }`
- Consumes: 现有 `assertEndpointProvider`（AI 分支）

- [ ] **Step 1: 写失败测试**

`backend/test/record-identity.test.ts`:

```ts
import assert from 'node:assert/strict'
import { ApiType, ApiEndpoint } from '../src/types'
import { resolveRecordIdentity } from '../src/record-identity'

function testPassthroughIdentity(): void {
  const id = resolveRecordIdentity({
    path: '/v1/models',
    apiType: ApiType.Passthrough,
    apiEndpoint: ApiEndpoint.Passthrough,
  })
  assert.deepEqual(id, {
    kind: 'passthrough',
    provider: ApiType.Passthrough,
    endpoint: ApiEndpoint.Passthrough,
  })
}

function testPassthroughRejectsMixed(): void {
  assert.throws(
    () => resolveRecordIdentity({
      path: '/v1/models',
      apiType: ApiType.Passthrough,
      apiEndpoint: ApiEndpoint.OpenAIChat,
    }),
    /passthrough/,
  )
  assert.throws(
    () => resolveRecordIdentity({
      path: '/v1/chat/completions',
      apiType: ApiType.OpenAI,
      apiEndpoint: ApiEndpoint.Passthrough,
    }),
    /passthrough/,
  )
}

function testAiIdentityStillResolvesPath(): void {
  const id = resolveRecordIdentity({
    path: '/v1/chat/completions',
    apiType: ApiType.OpenAI,
    apiEndpoint: ApiEndpoint.OpenAIChat,
  })
  assert.equal(id.kind, 'ai')
  assert.equal(id.provider, 'openai')
  assert.equal(id.endpoint, 'openai-chat')
}

function testAiRejectsPathMismatch(): void {
  assert.throws(
    () => resolveRecordIdentity({
      path: '/v1/messages',
      apiType: ApiType.OpenAI,
      apiEndpoint: ApiEndpoint.OpenAIChat,
    }),
  )
}

function main(): void {
  testPassthroughIdentity()
  testPassthroughRejectsMixed()
  testAiIdentityStillResolvesPath()
  testAiRejectsPathMismatch()
  console.log('record identity tests passed')
}

main()
```

- [ ] **Step 2: 运行确认失败**

```bash
npx tsx backend/test/record-identity.test.ts
```

Expected: FAIL（模块/导出不存在）。

- [ ] **Step 3: 扩展 `backend/src/types.ts`**

将现有：

```ts
export type ApiType = 'openai' | 'anthropic';
export type ApiEndpoint = 'openai-chat' | 'openai-responses' | 'anthropic-messages';
export type RequestListFilter = 'all' | 'openai' | 'anthropic' | 'streaming' | 'error';
```

替换为（保留其余类型不变）：

```ts
export const ApiType = {
  OpenAI: 'openai',
  Anthropic: 'anthropic',
  Passthrough: 'passthrough',
} as const;
export type ApiType = (typeof ApiType)[keyof typeof ApiType];

export const ApiEndpoint = {
  OpenAIChat: 'openai-chat',
  OpenAIResponses: 'openai-responses',
  AnthropicMessages: 'anthropic-messages',
  Passthrough: 'passthrough',
} as const;
export type ApiEndpoint = (typeof ApiEndpoint)[keyof typeof ApiEndpoint];

export const RequestListFilter = {
  All: 'all',
  OpenAI: 'openai',
  Anthropic: 'anthropic',
  Passthrough: 'passthrough',
  Streaming: 'streaming',
  Error: 'error',
} as const;
export type RequestListFilter = (typeof RequestListFilter)[keyof typeof RequestListFilter];
```

注意：全仓凡 `import type { ApiType }` 仍可工作；若某处需要常量值，改为值导入。

- [ ] **Step 4: 实现 `backend/src/record-identity.ts`**

```ts
import { assertEndpointProvider } from './endpoints';
import { ApiEndpoint, ApiType } from './types';

export interface RecordIdentity {
  kind: 'ai' | 'passthrough';
  provider: ApiType;
  endpoint: ApiEndpoint;
}

export function resolveRecordIdentity(input: {
  path: string;
  apiType: ApiType;
  apiEndpoint: ApiEndpoint;
}): RecordIdentity {
  const isPassthroughType = input.apiType === ApiType.Passthrough;
  const isPassthroughEndpoint = input.apiEndpoint === ApiEndpoint.Passthrough;
  if (isPassthroughType || isPassthroughEndpoint) {
    if (!isPassthroughType || !isPassthroughEndpoint) {
      throw new Error(
        `passthrough 记录的 apiType/apiEndpoint 必须同时为 passthrough: path=${input.path}, apiType=${input.apiType}, apiEndpoint=${input.apiEndpoint}`,
      );
    }
    return {
      kind: 'passthrough',
      provider: ApiType.Passthrough,
      endpoint: ApiEndpoint.Passthrough,
    };
  }

  const definition = assertEndpointProvider(input.path, input.apiType);
  if (definition.endpoint !== input.apiEndpoint) {
    throw new Error(
      `写入记录的 apiEndpoint 与 path 不一致: path=${input.path}, actual=${input.apiEndpoint}, expected=${definition.endpoint}`,
    );
  }
  return {
    kind: 'ai',
    provider: definition.provider,
    endpoint: definition.endpoint,
  };
}

export function isPassthroughEndpoint(endpoint: ApiEndpoint): boolean {
  return endpoint === ApiEndpoint.Passthrough;
}
```

- [ ] **Step 5: 注册测试脚本并跑通**

`package.json`:

```json
"test:identity": "tsx backend/test/record-identity.test.ts"
```

将 `npm run test:identity` 插入 `test:all` 链（建议在 `test:endpoints` 附近）。

```bash
npm run test:identity
```

Expected: `record identity tests passed`

- [ ] **Step 6: Commit（仅用户授权后）**

```bash
git add backend/src/types.ts backend/src/record-identity.ts backend/test/record-identity.test.ts package.json
git commit -m "$(cat <<'EOF'
feat(types): 增加 passthrough 类型与记录身份解析

EOF
)"
```

---

### Task 2: 删除 capture 积压 truncate，保留 1 MiB drain

**Files:**
- Modify: `backend/src/recorder/capture-queue.ts`
- Modify: `backend/src/recorder/client.ts`
- Modify: `backend/src/recorder/protocol.ts`
- Modify: `backend/src/recorder/worker.ts`（去掉 `truncated` 字段与分支，可在本 task 清协议侧，完成态语义在 Task 4 收尾）
- Modify: `backend/test/recorder-capture-queue.test.ts`

**Interfaces:**
- Produces: `DeferredCaptureQueue` 仅需 `{ maxDrainBytes?, schedule, deliver }`；`enqueue` 始终成功入队（返回 `void` 或恒 `true`）
- Consumes: 无

- [ ] **Step 1: 改写队列测试（先失败）**

替换/重写 `backend/test/recorder-capture-queue.test.ts`：

1. 删除 `testPendingLimitIncludesDeferredBytes`。
2. 所有构造去掉 `maxPendingBytes` / `truncate`。
3. 新增「大体量可持续入队」：连续 enqueue 超过旧 64 语义的多块（例如 8 块 × 1MiB 可用小数字模拟：maxDrain=3，enqueue 多块不 truncate）。
4. 保留 defer copy、bounded drain 保序、whenIdle 测试。

示例新测：

```ts
function testEnqueueNeverTruncates(): void {
  const scheduled: Array<() => void> = []
  const delivered: number[] = []
  const queue = new DeferredCaptureQueue({
    maxDrainBytes: 3,
    schedule: callback => scheduled.push(callback),
    deliver: item => delivered.push(item.chunk.byteLength),
  })

  for (let i = 0; i < 5; i++) {
    queue.enqueue('response', 'r1', Uint8Array.from([1, 2, 3]))
  }
  assert.equal(queue.pendingBytes, 15)
  // drain 全部
  while (scheduled.length) scheduled.shift()?.()
  assert.deepEqual(delivered, [3, 3, 3, 3, 3])
  queue.acknowledge(15)
  assert.equal(queue.pendingBytes, 0)
}
```

- [ ] **Step 2: 跑测确认失败**

```bash
npm run test:capture-queue
```

Expected: FAIL（仍要求 maxPending/truncate 或仍截断）。

- [ ] **Step 3: 精简 `capture-queue.ts`**

目标 API：

```ts
interface DeferredCaptureQueueOptions {
  maxDrainBytes?: number
  schedule(callback: () => void): void
  deliver(item: DeferredCaptureItem): void
}
```

- 删除 `truncate` 类型、`QueuedTruncateItem`、`truncatedIds`、`maxPendingBytes` 检查。
- `enqueue`：总是 push chunk、累加 `totalPendingBytes`、`ensureScheduled`；可改为返回 `void`。
- `drain`：不再处理 `truncate` item。
- 保留 `acknowledge` / `release`（release 可为空操作或仅兼容调用方）/ `clear` / `whenIdle`。
- 若 `release` 仅服务 truncate 恢复，可保留空实现以免 client 大改，或删掉 client 中的 `release` 调用。

- [ ] **Step 4: 清理 `protocol.ts`**

从 `MainToRecorderMessage` 删除：

```ts
| { type: 'capture.truncated'; id: string; pendingBytes: number }
```

- [ ] **Step 5: 清理 `client.ts`**

- 删除 `MAX_PENDING_CAPTURE_BYTES`、`truncatedCaptures`、`truncateCapture`。
- 构造 queue 时只传 `maxDrainBytes: MAX_CAPTURE_DRAIN_BYTES`、`schedule`、`deliver`。
- `postCaptureChunk` 不再检查 `truncatedCaptures`。
- `finalizeCaptureQueue` 不再 `release`/`truncatedCaptures.delete`（若 queue.release 删除则同步删）。

- [ ] **Step 6: Worker 去掉 truncated 分支（最小）**

- `CaptureState.truncated` 删除。
- `case 'capture.truncated'` 删除。
- `persist*` 中 `state.truncated ? ...` 改为仅正常 finished/error 路径（不再出现 `capture_truncated` / 「积压被截断」文案）。
- `buildResponseContent` 删除 `if (state.truncated) return null`。

- [ ] **Step 7: 跑通队列与相关测试**

```bash
npm run test:capture-queue
npm run test:shutdown
npm run test:worker
```

Expected: PASS（若 worker 测试依赖 truncate，同步改断言）。

- [ ] **Step 8: Commit（仅用户授权后）**

```bash
git add backend/src/recorder backend/test/recorder-capture-queue.test.ts backend/test/recorder-worker.test.ts
git commit -m "$(cat <<'EOF'
refactor(recorder): 移除 capture 64MiB 截断，保留 1MiB drain

EOF
)"
```

---

### Task 3: Entity + store 透传落库 / 筛选 / stats / preview

**Files:**
- Modify: `backend/src/entity/RequestEntity.ts`
- Modify: `backend/src/store.ts`
- Modify: `backend/test/store-preview.test.ts`
- Create 或扩展：`backend/test/store-passthrough.test.ts`（推荐独立，避免 preview 文件过大）
- Modify: `package.json`（`test:passthrough-store` 或并入 `test:preview`）

**Interfaces:**
- Consumes: `resolveRecordIdentity`、`ApiType`、`ApiEndpoint`、`RequestListFilter`
- Produces:
  - `getStats(): { total, openai, anthropic, passthrough, streaming, error }`
  - `getAll` counts 同结构含 `passthrough`
  - 读写透传记录不抛

- [ ] **Step 1: Entity 增加列**

`RequestEntity`：

```ts
/** 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'passthrough' */
@Column('text')
api_endpoint!: string;
```

放在 `api_type` 列附近。注释标明读路径以本列为准。

- [ ] **Step 2: 写 store 透传失败测试**

`backend/test/store-passthrough.test.ts` 模式对齐 `store-preview.test.ts`（tmp db + `setConfig` + `initDb`）：

```ts
// 伪代码要点
await upsertRecord({
  id: 'pt-1',
  timestamp: new Date().toISOString(),
  method: 'GET',
  path: '/v1/models',
  upstreamUrl: 'http://upstream.test/v1/models',
  requestHeaders: { accept: 'application/json' },
  requestBody: null,
  responseStatus: 200,
  responseContent: { object: 'list', data: [] },
  responseBody: '{"object":"list","data":[]}',
  streaming: false,
  durationMs: 12,
  apiType: ApiType.Passthrough,
  apiEndpoint: ApiEndpoint.Passthrough,
  state: 'done',
  finished: 'ok',
})

const detail = await getById('pt-1')
assert.equal(detail?.apiType, 'passthrough')
assert.equal(detail?.apiEndpoint, 'passthrough')
assert.equal(detail?.path, '/v1/models')

const page = await getAll(1, 10, 'passthrough')
// assert items 含 pt-1，counts.passthrough >= 1

const stats = await getStats()
assert.ok(stats.passthrough >= 1)

// AI 记录仍可写
await upsertRecord(/* openai-chat 样例 */)
// filter openai 不含 pt-1
```

另测 preview：透传 preview 以 `GET /v1/models` 开头（见 Step 4 规则）。

- [ ] **Step 3: 运行确认失败**

```bash
npx tsx backend/test/store-passthrough.test.ts
```

Expected: FAIL（assertEndpointProvider / 无列 / 无 filter）。

- [ ] **Step 4: 改造 `store.ts`**

关键改动清单：

1. `import { resolveRecordIdentity, isPassthroughEndpoint } from './record-identity'`，移除业务路径上直接 `assertEndpointProvider`（改由 identity）。
2. `upsertRecord`：
   ```ts
   const identity = resolveRecordIdentity({
     path: r.path,
     apiType: r.apiType,
     apiEndpoint: r.apiEndpoint,
   });
   // 使用 identity.provider / identity.endpoint 写入
   ```
3. `repo.save` 增加 `api_endpoint: identity.endpoint`；`api_type: identity.provider`。
4. `entityToRecord` / `entityToSummary`：
   ```ts
   const identity = resolveRecordIdentity({
     path: row.path,
     apiType: row.api_type as ApiType,
     apiEndpoint: (row.api_endpoint as ApiEndpoint) // 见下
   });
   ```
   注意：旧代码无 `api_endpoint` 列时 DB 会重建；新代码必须读写该列。若行缺失（不应发生），可 throw 明确错误。
5. **不要**在读路径调用 `resolveEndpoint(row.path)` 反推 endpoint。
6. `buildTokenSummary`：若 `isPassthroughEndpoint(endpoint)` 直接 `return {}`。
7. `buildPreview`：
   ```ts
   if (isPassthroughEndpoint(record.apiEndpoint)) {
     const base = `${record.method} ${record.path}`;
     // 可选：从 requestBody/responseContent 抽短摘要，总长仍 slice(0,80) 在 toSummary
     return base;
   }
   // 现有 findLatestMessage 逻辑
   ```
8. `buildSummaryWhere` 增加：
   ```ts
   case 'passthrough':
     where = { api_type: 'passthrough' };
     break;
   ```
9. `getAll` counts 与 `getStats` 增加：
   ```ts
   const passthrough = await repo.count({ where: { api_type: 'passthrough' } });
   ```
   返回类型加入 `passthrough: number`。
10. `SUMMARY_SELECT` 增加 `api_endpoint: true`（若 summary 映射需要；当前 summary 用 identity 需要该列）。
11. `request_body` 写入：现有 `r.requestBody ? JSON.stringify(r.requestBody)` 对空字符串 `""` 为 falsy 会丢——透传空 body 用 `null`；非空字符串应 `JSON.stringify` 能保留。检查并改为对 `undefined/null` 写 undefined，其余 `JSON.stringify(r.requestBody)`（字符串会变成 `"\"text\""` 入库，读回经 `safeJsonParse` 变字符串——若 requestBody 存 raw string 列当前是「对象 stringify」。保持与现网一致：对象/数组 stringify；**纯字符串**也 `JSON.stringify` 以便 `safeJsonParse` 还原字符串）。

- [ ] **Step 5: 跑通 store 测试**

```bash
npx tsx backend/test/store-passthrough.test.ts
npm run test:preview
```

Expected: PASS。

- [ ] **Step 6: Commit（仅用户授权后）**

```bash
git add backend/src/entity/RequestEntity.ts backend/src/store.ts backend/test/store-passthrough.test.ts backend/test/store-preview.test.ts package.json
git commit -m "$(cat <<'EOF'
feat(store): 支持透传记录落库、筛选与统计

EOF
)"
```

---

### Task 4: body-decode 文本回退 + Worker 透传语义

**Files:**
- Modify: `backend/src/body-decode.ts`
- Modify: `backend/test/body-decode.test.ts`
- Modify: `backend/src/recorder/worker.ts`
- Modify: `backend/test/recorder-worker.test.ts`

**Interfaces:**
- Produces: `decodeRequestBody` 在 JSON 失败且 buffer 为有效 UTF-8 文本时返回 `{ parsed: string }`（或明确字段）；二进制失败仍 `{ error }`
- Worker：`isPassthroughEndpoint(metadata.apiEndpoint)` 时跳过 merge/tools/usage/terminal

- [ ] **Step 1: body-decode 测试**

在 `body-decode.test.ts` 增加：

```ts
// 非 JSON 纯文本
const text = Buffer.from('not-json-plain-text', 'utf8')
const r = decodeRequestBody(text, undefined)
assert.equal(r.parsed, 'not-json-plain-text')
assert.equal(r.error, undefined)

// 非法 UTF-8 / 或明确二进制策略：若实现选择「含 � 则 error」，写对应断言
```

- [ ] **Step 2: 实现文本回退**

`decodeRequestBody` JSON.parse 失败时：

```ts
const text = decompressed.buffer.toString('utf8')
// 简单策略：若 Buffer 与 utf8 round-trip 一致则视为文本
if (Buffer.from(text, 'utf8').equals(decompressed.buffer)) {
  return { parsed: text }
}
return { error }
```

空 body 仍 `{}`。

- [ ] **Step 3: Worker 透传分支**

1. `import { isPassthroughEndpoint } from '../record-identity'`（或从 types 比常量）。
2. `finishRequestCapture`：仅当 **非** passthrough 且 `decoded.parsed !== undefined` 时 `backfillToolResults`。
3. `buildResponseContent`：
   ```ts
   if (isPassthroughEndpoint(state.metadata.apiEndpoint)) {
     if (state.streaming) return null;
     try { return JSON.parse(state.responseText); }
     catch { return null; }
   }
   // 现有 AI 逻辑
   ```
4. `persistCompletedCapture` / `persistPartialCapture`：
   - passthrough：`apiUsage` 不写（`undefined`/`null`）；**不** `writeToolCalls`。
   - AI：保持现状。
5. `closeCapture`：passthrough **不要**走 `isTerminalCapture`；流式/非流式统一：
   - 有 response 且非 abort → 可 `persistCompletedCapture(..., 'client_close')` 或 partial；spec：不做 terminal 判断，不因缺 terminal 打 AI incomplete warning。
   - 推荐：passthrough + `downstream_closed` → 若已有 `response_start` 则 `persistCompletedCapture(state, 'client_close')`（error 空）；若无响应则 partial/abort 合适分支。**禁止**对透传调用 `isTerminalSSE`。
6. 删除所有 truncated 残留（若 Task 2 未净）。

- [ ] **Step 4: Worker 测试**

在 `recorder-worker.test.ts` 增加透传用例（若该文件用集成 worker 消息）：

- metadata `apiEndpoint: 'passthrough'`
- 非 JSON 响应 body 完整进 `responseBody`，`responseContent` 可为 null
- 间谍/断言不触发 merge（可通过响应非 SSE 且 path 非注册仍成功落库证明）
- AI 用例回归不坏

若 worker 测试难以 spy merge，至少断言：透传记录 `api_type=passthrough`、无 tool_calls 行、无 api_usage。

- [ ] **Step 5: 运行**

```bash
npm run test:decode
npm run test:worker
```

Expected: PASS。

- [ ] **Step 6: Commit（仅用户授权后）**

```bash
git add backend/src/body-decode.ts backend/src/recorder/worker.ts backend/test/body-decode.test.ts backend/test/recorder-worker.test.ts
git commit -m "$(cat <<'EOF'
feat(recorder): 透传完成态跳过协议合并并改进 body 解码

EOF
)"
```

---

### Task 5: Proxy 透传也 capture

**Files:**
- Modify: `backend/src/proxy.ts`
- Modify: `backend/test/proxy-data-plane.test.ts`

**Interfaces:**
- Consumes: `beginCapture` metadata 使用 `ApiType.Passthrough` / `ApiEndpoint.Passthrough`
- Produces: 任意 `handlePassthrough` 请求带 UUID 与完整 capture 生命周期

- [ ] **Step 1: 扩展 proxy 测试**

在 `proxy-data-plane.test.ts` 增加（或改）用例：

- 调用 `handlePassthrough`（或未注册 path 的 forward）时，recorder mock 收到 `capture.start`，且 `metadata.apiType === 'passthrough'`、`apiEndpoint === 'passthrough'`，`id` 为 UUID。
- 请求/响应 chunk 仍被观察（与现有 AI 测试对称）。
- 日志字段含真实 requestId（若测试抓 log，可选）。

若现有测试 stub `beginCapture`，断言 passthrough 也会调用。

- [ ] **Step 2: 运行确认失败**

```bash
npm run test:proxy
```

Expected: FAIL（passthrough id 仍为 null）。

- [ ] **Step 3: 修改 `forward()`**

核心变更：

```ts
const isRecorded = true; // 所有经 forward 的代理流量都记录
// 或：始终生成 id
const id = crypto.randomUUID();
const label = endpointDefinition ? 'proxy' : 'passthrough';

beginCapture({
  id,
  startedAt,
  timestamp: new Date().toISOString(),
  method: req.method,
  path: req.path,
  upstreamUrl: targetUrl,
  requestHeaders: flattenHeaders(filterHeaders(req.headers)),
  contentEncoding,
  apiType: endpointDefinition?.provider ?? ApiType.Passthrough,
  apiEndpoint: endpointDefinition?.endpoint ?? ApiEndpoint.Passthrough,
  sessionId: session?.value,
  sessionIdKey: session?.key,
});
```

- 删除 `const id = endpointDefinition ? crypto.randomUUID() : null` 分叉。
- request tap / response observe / complete/close/fail 全部走 `context.id`（现已是 string | null → 改为始终 string）。
- `ProxyContext.id: string`（不再 null）。
- `contextLogFields` 的 `requestId: context.id`（去掉 `?? '-'`）。

- [ ] **Step 4: 跑通 proxy 测试**

```bash
npm run test:proxy
```

Expected: PASS。

- [ ] **Step 5: Commit（仅用户授权后）**

```bash
git add backend/src/proxy.ts backend/test/proxy-data-plane.test.ts
git commit -m "$(cat <<'EOF'
feat(proxy): 透传路径写入 Recorder capture

EOF
)"
```

---

### Task 6: 后端 API filter 解析

**Files:**
- Modify: `backend/src/index.ts`

**Interfaces:**
- `parseRequestListFilter` 接受 `'passthrough'`

- [ ] **Step 1: 更新 allowedFilters**

```ts
const allowedFilters: RequestListFilter[] = [
  'all', 'openai', 'anthropic', 'passthrough', 'streaming', 'error',
];
```

使用 `RequestListFilter` 常量值更佳：

```ts
import { RequestListFilter } from './types';
const allowedFilters = Object.values(RequestListFilter);
```

注意：`Object.values` 在 `as const` 对象上可用。

- [ ] **Step 2: 快速编译检查**

```bash
npm run build
```

Expected: 无类型错误。

- [ ] **Step 3: Commit（仅用户授权后）**

```bash
git add backend/src/index.ts
git commit -m "$(cat <<'EOF'
feat(api): 列表 filter 支持 passthrough

EOF
)"
```

---

### Task 7: 前端类型、列表筛选与徽章

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/stores/requests.ts`
- Modify: `frontend/src/api/index.ts`（若 counts 类型写死）
- Modify: `frontend/src/views/ListView.vue`
- Modify: `frontend/src/App.vue`（全局 `.badge-*` 若在此）

**Interfaces:**
- Consumes: API counts 含 `passthrough`
- Produces: 顶栏顺序 `总计 · OpenAI · Anthropic · 透传 · 进行中 · 错误`

- [ ] **Step 1: 镜像类型**

`frontend/src/types.ts`：与后端相同的 `ApiType`/`ApiEndpoint`/`RequestListFilter` 常量 + 联合类型。

```ts
export type ApiProvider = ApiType // 兼容旧名
```

`RecordSummary` / `RecordedRequest` 的 `apiType`/`apiEndpoint` 使用新联合类型。

- [ ] **Step 2: store counts 与 filter**

```ts
const counts = ref({
  total: 0, openai: 0, anthropic: 0, passthrough: 0, streaming: 0, error: 0,
})

// matchesActiveFilter
case 'passthrough':
  if (record.apiType !== 'passthrough') return false
  break
```

`loadStats` / `fetchStats` 类型同步加 `passthrough`。

- [ ] **Step 3: ListView 顶栏与行**

顶栏：

```vue
<button ... @click="store.setFilter('all')">总计 {{ store.counts.total }}</button>
<button ... @click="store.setFilter('openai')">OpenAI {{ openaiCount }}</button>
<button ... @click="store.setFilter('anthropic')">Anthropic {{ anthropicCount }}</button>
<button ... @click="store.setFilter('passthrough')">透传 {{ passthroughCount }}</button>
<button ... class="stat-streaming" @click="store.setFilter('streaming')">进行中 {{ streamingCount }}</button>
<button ... @click="store.setFilter('error')">错误 {{ errorCount }}</button>
```

API 列：

```vue
<span v-if="r.apiType === 'passthrough'" class="badge badge-passthrough">透传</span>
<span v-else-if="r.apiType === 'anthropic'" class="badge badge-anthropic">Anthropic</span>
<span v-else class="badge badge-openai">OpenAI</span>
```

模型列：透传显示 `-`（`r.apiType === 'passthrough' ? '-' : r.model`）。

缓存/速度：透传保持 `-`（现有 `apiReportedInput` 空已是 `-`；TokenSpeed 对无 output 应已是空，确认透传不显示 tok/s）。

搜索 haystack 加入 `r.path`。

- [ ] **Step 4: 徽章样式**

在定义 `.badge-openai` 的同一处（`App.vue` 或全局 CSS）增加：

```css
.badge-passthrough {
  background: #e5e7eb;
  color: #374151;
  border: 1px solid #d1d5db;
}
```

- [ ] **Step 5: 前端类型检查/构建**

```bash
npm run build:frontend
```

Expected: PASS。

- [ ] **Step 6: Commit（仅用户授权后）**

```bash
git add frontend/src/types.ts frontend/src/stores/requests.ts frontend/src/api/index.ts frontend/src/views/ListView.vue frontend/src/App.vue
git commit -m "$(cat <<'EOF'
feat(ui): 列表增加透传筛选与徽章

EOF
)"
```

---

### Task 8: 前端详情透传布局

**Files:**
- Modify: `frontend/src/views/DetailView.vue`
- 按需：小范围 CSS scoped

**Interfaces:**
- Consumes: `record.apiEndpoint === 'passthrough'` 或 `ApiEndpoint.Passthrough`
- Produces: raw inspector 详情；无 MessageFlow / ContextComposition / 工具配对

- [ ] **Step 1: 计算属性**

```ts
import { ApiEndpoint } from '../types'
const isPassthrough = computed(
  () => record.value?.apiEndpoint === ApiEndpoint.Passthrough
    || record.value?.apiType === 'passthrough',
)
```

保留 `isOpenAI` 等仅用于非透传。

- [ ] **Step 2: 模板分支**

- meta：`API` 徽章三态；透传显示 `路径: method path`；速度在透传时为 `-` 或不渲染 TokenSpeed。
- **整块** AI 专用区（MessageFlow 入口、ContextComposition、response-flow 卡片、工具 hover 等）包在 `v-if="!isPassthrough"`。
- 透传主体 `v-if="isPassthrough"`：
  - 请求头 / 响应头（现有 headers 展示组件或 `<pre>`）
  - 请求体 / 响应体：tab「原始 | 美化 JSON」（JSON.parse 成功才显示美化；失败仅原始）
  - curl（现有 `buildCurl` 可复用；注意 requestBody 为 string 时不要 `JSON.stringify` 双重编码——修正 `buildCurl`：
    ```ts
    const body = typeof r.requestBody === 'string'
      ? r.requestBody
      : JSON.stringify(r.requestBody)
    ```
- `analyzeRequestBody`：透传直接 return，不启动 worker。

- [ ] **Step 3: 导出**

`doExport` 透传分支：输出 path/status/headers/body，不写「用户请求」协议段。

- [ ] **Step 4: 构建**

```bash
npm run build:frontend
```

Expected: PASS。

- [ ] **Step 5: Commit（仅用户授权后）**

```bash
git add frontend/src/views/DetailView.vue
git commit -m "$(cat <<'EOF'
feat(ui): 透传详情展示原始请求响应

EOF
)"
```

---

### Task 9: 文档同步与全量回归

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-07-14-proxy-log-semantics-design.md`（修正「passthrough 无 ID」「64 MiB 截断 incomplete 跳过」等过时句，改为指向新语义）
- 按需：README 若提到只记 AI endpoint

- [ ] **Step 1: 更新 CLAUDE.md**

至少修改：

- proxy / recorder 描述：透传也 capture；`apiType/apiEndpoint=passthrough`。
- 删除「64 MiB 积压上限 / truncate」；写明无 pending 上限，保留每轮 1 MiB drain，存在 OOM 风险。
- entity / store：`api_endpoint` 列；读路径不以 path 反推 endpoint。
- 类型：`as const` + 联合类型约定。
- 测试命令：新增 identity / passthrough store（若加了脚本）。

- [ ] **Step 2: 修正旧 design 过时句**

`2026-07-14-proxy-log-semantics-design.md`：

- 「passthrough 请求没有 Recorder ID」→ 透传同样有 UUID（见 2026-07-19 design）。
- 「捕获已因 64 MiB 积压截断时不重复输出 incomplete」→ 删除或改为「已取消积压截断」。

- [ ] **Step 3: 全量测试与构建**

```bash
npm run test:all
npm run build
npm run build:frontend
```

Expected: 全部 PASS。

- [ ] **Step 4: 手工验收清单（执行者勾选）**

1. `GET /v1/models`（或上游任意非注册 path）→ 列表「透传」、筛选计数 +1。
2. 详情 headers + body；JSON 可美化。
3. AI chat/messages 记录与合并无回归。
4. 大 body 不 truncate（日志无 backlog limit exceeded）。
5. 代理转发仍透明（对比直连上游 status/body）。

- [ ] **Step 5: Commit（仅用户授权后）**

```bash
git add CLAUDE.md docs/superpowers/specs package.json
git commit -m "$(cat <<'EOF'
docs: 同步透传记录与取消 64MiB 截断说明

EOF
)"
```

---

## Spec Coverage Checklist

| Spec 要求 | Task |
|-----------|------|
| 类型 as const + passthrough | 1 |
| resolveRecordIdentity 单一入口 | 1 |
| 取消 64MiB / 删 truncate / 保留 1MiB drain | 2 |
| api_endpoint 列；读以列为准 | 3 |
| store filter/stats/preview | 3 |
| body 文本回退；Worker 短路 | 4 |
| proxy 透传 capture + 真实 requestId | 5 |
| API filter passthrough | 6 |
| 列表顶栏顺序 A + 徽章 | 7 |
| 详情 raw 布局 | 8 |
| CLAUDE/旧文档 | 9 |
| 测试与 DoD | 2–5, 9 |

## Placeholder / Consistency Self-Review

- 无 TBD/TODO 步骤。
- 常量名统一 `ApiType.Passthrough` / `ApiEndpoint.Passthrough`。
- counts 字段名全链路 `passthrough`。
- Commit 步骤受全局「用户授权」约束，与项目 CLAUDE 一致。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-19-passthrough-recording.md`.

**Two execution options:**

1. **Subagent-Driven（推荐）** — 每 task 新开 subagent，task 间 review，迭代快  
2. **Inline Execution** — 本会话按 executing-plans 批量执行并设检查点  

Which approach?
