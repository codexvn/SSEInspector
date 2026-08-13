# 透传请求记录与筛选设计

## 目标

对未命中已注册 AI endpoint 的透传流量也记录请求与响应，并在检查器 UI 中以独立「透传」分类筛选与展示。同时取消 capture 队列 64 MiB 积压截断上限，保留每轮 1 MiB drain 以保护事件循环。

## 背景与现状问题

### 代理分叉

- 已注册 AI endpoint（`openai-chat` / `openai-responses` / `anthropic-messages`）走 `handleProxy`，生成 UUID 并 `beginCapture`。
- 其余路径走 `handlePassthrough` → 同一 `forward()`，但 `id = null`，不 tee 请求体、不观察响应体、不落库。
- 日志 label 已区分 `proxy` / `passthrough`，但透传没有 Recorder ID（`requestId: '-'`）。

### 持久化硬假设

- `store.upsertRecord` / `entityToRecord` / `entityToSummary` 强制 `assertEndpointProvider(path, apiType)`，未知 path 无法读写。
- `ApiType` / `ApiEndpoint` / `RequestListFilter` 仅覆盖 OpenAI / Anthropic 协议路径。
- 实体表无 `api_endpoint` 列，endpoint 靠 path 反推——透传无法使用该模型。

### 积压保护

- capture 队列 `maxPendingBytes = 64 MiB`：队列待投递字节 + Worker 未 ACK 字节合计超限则 truncate。
- 每轮 `maxDrainBytes = 1 MiB`：单次 `setImmediate` drain 最多复制投递 1 MiB，避免堵死事件循环。
- 二者职责不同：前者是存储/内存上限，后者是事件循环节流。

## 需求结论

| 维度 | 结论 |
|------|------|
| 范围 | 全部透传流量（进入 `handlePassthrough` 的请求；仍排除现有 catch-all 规则：`/api/*`、`/`、带扩展名的 GET 静态资源） |
| 深度 | 原始请求/响应 + 通用展示（JSON 可美化）；不做协议语义合并 |
| UI | 独立「透传」分类与筛选；顶栏顺序见下 |
| 积压 | **完全取消** 64 MiB pending 上限与 truncate |
| 类型表示 | `as const` 对象 + 派生联合类型；不用 TypeScript `enum` |

## 方案选型

采用 **统一 capture 管线 + 显式 passthrough 类型**（方案 A）。

- 数据面：透传与 AI 共用 request tee、response observe、延迟队列、Worker 投递。
- 语义面：Worker / store / UI 对 `passthrough` 短路协议逻辑。
- 拒绝：独立表 + 独立 API（双套列表/RPC）；仅元数据截断 body（无法复查）；path 猜测协议 merge（违反 endpoint 注册表原则）。

## 设计

### 1. 类型与常量

前后端语义一致。后端权威定义在 `backend/src/types.ts`；前端 `frontend/src/types.ts` 镜像同名同值（本需求不抽共享包）。前端现有 `ApiProvider` 可与 `ApiType` 对齐为同一联合类型，或保留别名 `type ApiProvider = ApiType`，避免两套 provider 字面量。

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

- 运行时比较使用 `ApiType.Passthrough` / `ApiEndpoint.Passthrough` 等常量。
- DB 列、query string、JSON API 仍为稳定字符串 `'passthrough'`。
- 业务代码禁止散落多处裸字符串判断；统一经身份解析入口（见下）。

### 2. 记录身份（单一入口）

概念上记录只有两类：

```ts
type RecordIdentity =
  | { kind: 'ai'; provider: 'openai' | 'anthropic'; endpoint: Exclude<ApiEndpoint, 'passthrough'> }
  | { kind: 'passthrough'; provider: 'passthrough'; endpoint: 'passthrough' };
```

- 提供 `resolveRecordIdentity({ path, apiType, apiEndpoint })`（名称以实现为准）：
  - 透传：`apiType` 与 `apiEndpoint` 必须同时为 `passthrough`，否则 throw；**不**调用 `resolveEndpoint(path)`。
  - AI：走现有 `assertEndpointProvider` / path↔endpoint 一致性校验。
- `upsertRecord`、读映射、Worker 分支、前端详情判断均经此语义（或等价 helper），避免四套重复 if。

### 3. Schema

- `RequestEntity` 增加 `api_endpoint` 列（text，必填）。
- 写入时同时落 `api_type` 与 `api_endpoint`。
- **读路径以 `api_endpoint`（及 `api_type`）为准**；path 仅展示与搜索，不承担协议分发。
- AI 写路径仍可校验 path 与 endpoint 一致，防止脏写。
- TypeORM `synchronize: true`；不兼容变更时删除旧 DB 重建，不写 migration（项目既有约定）。

### 4. 代理数据面

`handleProxy` / `handlePassthrough` 仍共用 `forward()`，行为对齐：

| 项 | AI endpoint | 透传 |
|----|-------------|------|
| `endpointDefinition` | 有 | 无 |
| `id` | UUID | UUID（原先 null） |
| 日志 label | `proxy` | `passthrough` |
| capture metadata | registry 的 provider/endpoint | 固定 `passthrough` / `passthrough` |
| request tee + response observe | 是 | 是 |
| httpxy 所有权 / 透明透传 | 不变 | 不变 |

约束不变：

- 主线程不解析 JSON/SSE、不访问数据库。
- 禁止手写 `http.request` / `res.write` 循环 / `selfHandleResponse`。
- 关闭与失败语义（`complete` / `closed` / `failed`）与现网一致；透传无协议 terminal SSE 判断（见 Worker）。

日志：透传开始/结束日志必须带真实 `requestId`（不再固定 `'-'`），便于与 Recorder 关联。

### 5. 取消 64 MiB 上限；保留 1 MiB drain

#### 删除（truncate 管线一次清干净）

- `MAX_PENDING_CAPTURE_BYTES` 与队列 `maxPendingBytes` 超限逻辑。
- `truncate` 回调、`truncatedCaptures`、`capture.truncated` 协议消息、Worker `state.truncated` 丢弃分支。
- 依赖 truncate 的测试与 CLAUDE.md / 旧设计文档中「64 MiB 积压截断」描述。

#### 保留

- `MAX_CAPTURE_DRAIN_BYTES = 1 MiB`：每轮 drain 最多复制投递 1 MiB，多出的留待后续 `setImmediate`。
- Worker `ack` 可保留（观测/调试），但不再驱动「超限丢弃」。

#### 可选观测（非截断）

- pending 字节超过既定水位（如 64 MiB、256 MiB）可打 info/warn **一次**，**不得**截断或拒绝入队。
- 不得复用已删除的 truncate 消息通道。

#### 内存语义（必须文档化）

取消上限后，Worker 慢或大体量并发时主线程队列与未投递 Buffer 可无限增长，可能导致进程 OOM。产品选择优先「完整记录、不截断」；运维需接受内存风险。1 MiB drain 只保护事件循环，不限制总积压。

### 6. Recorder Worker

透传与 AI 共用 capture 消息协议；`apiEndpoint === ApiEndpoint.Passthrough` 时：

| 步骤 | 行为 |
|------|------|
| 请求体 | 仍可 `body-decode`；**不** tool result backfill |
| 响应 streaming | content-type 含 `text/event-stream` 则 true |
| live 推送 | 流式时 `streamText` + 现有约 200ms 节流 |
| 完成 merge | **禁止** `mergeChunks` / 任意 accumulator |
| usage | **禁止** 写 `api_usage` |
| tool_calls | **禁止** 写 tool 表 |
| terminal SSE | **不做** 协议 terminal 判断；`closed`/`failed` 按通用状态落库 |
| incomplete warning | 不因「缺 terminal」对透传打 AI 专用 incomplete 语义 |

#### 请求体落库

1. decode 得到 JSON 对象 → `requestBody` 为对象（入库 JSON 字符串）。
2. 非 JSON 但可 UTF-8 文本 → `requestBody` 为字符串（入库为 JSON string 字面量）。
3. 无法安全表示 → `requestBody = null`；decode 失败仅 worker warn，不单独因 body 将整单标为业务 error（除非 `capture.failed`）。

#### 响应体落库

- 始终保留完整 raw 于 `response_body`（流式 = raw SSE 文本；非流式 = 原始响应文本）。
- `response_content`：非流式且 `JSON.parse` 成功则存对象（供美化）；否则 `null`。
- 禁止将未知 SSE 合成伪 Chat/Messages/Responses 结构。

### 7. store / preview / stats

- `upsertRecord` 经 `resolveRecordIdentity`；透传跳过 path 注册表。
- `entityToRecord` / `entityToSummary`：透传直接映射常量身份，不 `resolveEndpoint`。
- `buildSummaryWhere('passthrough')` → `{ api_type: 'passthrough' }`。
- `getAll` counts 增加 `passthrough`；结构为  
  `{ openai, anthropic, passthrough, streaming, error }`（一次加全，不做半个 optional 字段）。
- `toSummary` / preview：
  - 透传：`` `${method} ${path}` `` + 可选短摘要（JSON 可取 `model`/`error`/`object` 等或 body 前 80 字）。
  - `model`：默认可为 `unknown`；若 JSON 中有字符串 `model` 可填入仅供展示。
  - token 摘要字段对透传不计算（列表显示 `-`）。

### 8. 前端 UI

#### 列表顶栏顺序（已确认 A）

`总计 · OpenAI · Anthropic · 透传 · 进行中 · 错误`

- 点击「透传」→ `filter=passthrough`。
- openai/anthropic 筛选**不包含**透传；`all` 包含全部。

#### 列表行

- API 列：灰色「透传」徽章（建议背景 `#e5e7eb`、字色 `#374151`），与蓝 OpenAI / 粉 Anthropic 区分。
- 模型 / 缓存命中 / 速度：透传显示 `-`。
- 预览：method + path 摘要；流式透传可显示「流式传输中…」。
- 搜索 haystack 包含 `path`。

#### 详情页

- meta：透传徽章、path、status、duration 等；速度为 `-`。
- 主体：请求头 / 响应头 / 请求体 / 响应体（原始 | 美化 JSON）+ curl。
- SSE 透传：响应体以 raw 文本为主。
- **不展示**：MessageFlow、工具配对、上下文组成分析、token 占比、协议响应卡片流。
- 实现上用单一 `isPassthrough`（或等价）驱动布局，避免模板多处裸比较。

### 9. 实现约束（防落地走歪）

1. 单一身份解析入口；禁止业务多处复制 `=== 'passthrough'` 判断分支（展示文案除外）。
2. truncate 管线本需求内**删除**，不是 disable；`DeferredCaptureQueue` 不再接受 `maxPendingBytes` / `truncate` 参数。
3. 读路径以 `api_endpoint` 为准；path 不承担协议分发。AI 历史写入路径在实现后必须同时写入 `api_endpoint` 列。
4. Worker 透传路径零调用 merge / tools / usage（测试锁定）。
5. counts/filter API 一次加全 `passthrough`。
6. 不借机重写整个 endpoint registry、不上共享 package、不换运行时语言。

### 10. 文档同步

实现完成后更新：

- 根 `CLAUDE.md`：透传也 capture；无 64 MiB 上限；保留 1 MiB drain；`api_endpoint` 列；类型常量约定。
- 本 design 已覆盖的旧文档中「passthrough 无 ID」「64 MiB 截断」表述需在实现 PR 中一并修正（如 proxy-log 设计中相关句）。

## 非目标

- 透传协议语义合并、tool pairing、API usage / 本地 tokenizer。
- 独立 `passthrough_requests` 表或独立列表 API。
- TypeScript `enum`。
- 可配置 capture 上限或采样策略框架（本需求为完全取消上限）。
- 换 Go / Bun / 重写数据面。
- 历史 DB 数据迁移。
- 在主线程按 path 白/黑名单过滤透传记录。

## 测试与验收

### 自动化

- store：透传 upsert/read；filter/counts；AI path 校验行为不变。
- proxy：passthrough 生成 id 并 capture chunk；label 仍为 `passthrough`。
- worker：透传不 merge/tools/usage；JSON / 非 JSON / SSE body 落库正确。
- capture queue：无 maxPending truncate；1 MiB drain 行为保留。
- 回归：`test:proxy`、`test:worker` 及相关 suite 全绿。

### 手工 / DoD

1. 未注册 path（如 `GET /v1/models`、embeddings、health）出现在列表，API=「透传」，顶栏「透传 N」可筛。
2. 详情可见 headers 与完整 body；JSON 可美化。
3. 代理仍原样透传；主线程不解析协议。
4. 流式透传可 live 更新且不调用 SSE merger。
5. 无 64 MiB truncate；大体量只受机器内存约束。
6. OpenAI / Anthropic 原有记录与合并行为无回归。

## 风险

| 风险 | 缓解 |
|------|------|
| 取消上限后 OOM | 文档标明；可选 pending 水位日志；保留 1 MiB drain |
| 列表被透传噪声淹没 | 独立筛选；默认「总计」用户可切走 |
| 详情误入 MessageFlow | `isPassthrough` 早退 |
| 半残 truncate 代码 | 实现约束要求整条删除 |
| 旧 DB 不兼容 | 删库重建，不 migration |

## UI 草图参考

头脑风暴阶段 visual companion 草图（列表顶栏顺序 A、透传徽章、raw 向详情）已确认；实现以本文文字约束为准。
