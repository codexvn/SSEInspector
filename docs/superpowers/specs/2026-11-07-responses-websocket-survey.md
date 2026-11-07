# OpenAI Responses WebSocket 模式调研

## 背景与问题

SSEInspector 目前只代理和记录 HTTP/SSE 请求。OpenAI 于 2026 年 2 月为 Responses API 推出 WebSocket 模式：客户端通过 `wss` 连接 `GET /v1/responses`，在同一条连接上多路复用多个响应。要支持该模式，需要先回答两个问题：其一，OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种协议的输出格式各自如何组织，WebSocket 模式与它们是什么关系；其二，WebSocket 连接的事件格式、生命周期和错误语义是什么，透明代理应如何处理。

本调研的参考实现是 CLIProxyAPI（router-for-me/CLIProxyAPI，下称 CPA），克隆到临时目录 `.tmp/CLIProxyAPI`（该目录不提交）。CPA 是 Go 编写的终止式协议网关——终止式指代理分别终结上下游两条连接并自行实现协议语义，而非原样转发字节——同时实现了 Responses WebSocket 的服务端入口与上游 wss 客户端，是当前最完整的开源参照。官方依据来自 OpenAI 文档的 WebSocket 模式指南与 WebSocket 事件参考（在页面 URL 后追加 `.md` 可获得 Markdown 版本）。

## 三种协议的输出格式如何组织

SSEInspector 现状（`backend/src/endpoints.ts`）按 API 接口形态（API surface）注册三个 endpoint：`openai-chat`（`/chat/completions$`）、`openai-responses`（`/responses$`）、`anthropic-messages`（`/messages$`），每个 endpoint 绑定一个 accumulator（流式合并器，把流式事件合并为完整响应结构）。输出格式随 API 接口形态（endpoint 与流式事件类型）区分，而不是随模型区分：同一模型族（例如 gpt-5.x 全系）共享同一份事件 schema，换模型不换格式。这个判断与官方事件参考一致——事件类型只按 API（Chat / Responses / Messages）划分，不按模型划分。

CPA 用矩阵组织同一件事：`internal/translator/<上游供应商>/<客户端协议>/<变体>/`，例如 `translator/codex/claude/`（Codex 上游服务 Claude 协议客户端）、`translator/claude/openai/responses/`（Claude 上游服务 Responses 协议客户端）。每个目录固定三个文件：`*_request.go` 负责入向翻译，`*_response.go` 负责出向翻译，`init.go` 负责注册。客户端协议共四种：`openai/chat-completions`、`openai/responses`、`claude`、`gemini`。CPA 需要这张矩阵是因为它要在供应商之间互转协议；SSEInspector 是透明代理，不做协议互转，因此不需要引入这张矩阵，现有的「endpoint → accumulator」一维注册表已经够用，WebSocket 支持也只是给它增加一个传输维度。

## Responses WebSocket 的事件格式

### 客户端事件（两种）

`response.create` 是主要的客户端事件，载荷与 `POST /v1/responses` 的请求体相同，外加 WebSocket 专属的 `stream_id` 字段；`stream` 与 `background` 两个传输字段不使用。`generate: false` 表示预热：只准备请求状态不生成输出，返回的 response ID 可供后续 `previous_response_id` 链接。`response.steer` 是中途转向事件，只含 `type`、`previous_response_id`、`input` 三个字段，仅接受 `user` 角色消息。

### 服务端事件（信封 + 内层事件）

服务端事件套一层信封：`{"type":"message","stream_id":"...","message":{...}}`，信封内的 `message` 就是与 SSE 流式完全同构的 Responses 事件（`response.created` → `response.in_progress` → `response.output_item.added` → `response.output_text.delta` → … → `response.completed` / `response.failed` / `response.incomplete`）。这一点是 SSEInspector 复用现有 `openai-responses` accumulator 的直接依据：剥离信封之后，内层事件流可以直接输入给现有合并器，不需要写第二套事件模型。

除共享事件外，WebSocket 专属的服务端事件有四类：

- `error`：请求级或协议级错误，形如 `{"type":"error","status":400,"stream_id":"...","error":{"type":"invalid_request_error","code":"...","message":"...","param":"..."}}`。请求级错误不关闭连接，其他 lane（lane 指同一连接内按 `stream_id` 划分的并发请求通道，见下节）可以继续。
- `response.steer.accepted` / `response.steer.pending` / `response.steer.failed`：转向事件的确认、挂起（等待工具结果）与失败回执，失败事件会带回原始未提交的 `input`。

官方事件参考列出的共享事件全集包括：`response.created`、`response.in_progress`、`response.completed`、`response.failed`、`response.incomplete`、`response.queued`、`response.output_item.added/done`、`response.content_part.added/done`、`response.output_text.delta/done`、`response.refusal.delta/done`、`response.function_call_arguments.delta/done`、`response.reasoning_summary_part.added/done`、`response.reasoning_summary_text.delta/done`、`response.reasoning_text.delta/done`、`response.output_text.annotation.added`、各类工具调用进度事件（file_search、web_search、image_generation、code_interpreter、mcp、shell、custom_tool_call_input、audio、compaction）。

### stream_id 与连接语义

`stream_id` 是一条连接内的有序 lane：1–256 个字符，仅允许字母、数字、下划线、连字符、句点。同 lane 请求先进先出、不重叠；不同 lane 并发执行、事件交错。省略 `stream_id` 表示隐式默认 lane，此时服务端事件也不携带 `stream_id`。`stream_id` 只管事件路由，`previous_response_id` 只管会话血缘，两者独立——新 lane 可以从旧 lane 的响应派生。

连接级限制：单连接最多 16 个在途响应、32 个命名 lane、连接寿命 60 分钟，到时需重连。错误码中与传输相关的四个：`previous_response_not_found`（缓存未命中，需重发完整上下文）、`invalid_stream_id`、`websocket_stream_limit_reached`（32 个命名 lane 用满）、`websocket_connection_limit_reached`（60 分钟到期）。

## CPA 的 WebSocket 处理解剖

### 服务端入口与同路径复用

CPA 在同一路径上按 HTTP 方法分流：`GET /v1/responses` 注册为 `ResponsesWebsocket`（gorilla/websocket 升级），`POST /v1/responses` 走普通 HTTP handler（`internal/api/server_routes.go:87-88`）。升级时仅向下游透传 `x-codex-turn-state` 请求头以保持重连后的粘性轮次状态。CPA 额外注册了 `/backend-api/codex/responses` 的同构路由以直接服务 Codex CLI。

### 下游连接生命周期（`sdk/api/handlers/openai/openai_responses_websocket.go`）

升级成功后，handler 为连接分配 UUID 会话 ID，启动独立的读 pump goroutine（读循环不阻塞转发循环，`response.interrupt` 可即时透传），然后进入按消息驱动的主循环：读 text frame → 解析 `type` → 每轮重新鉴权（把 WS 载荷重放成等价 POST 请求过 AccessManager）→ 翻译路由 → 调用执行器 → 把上游事件流逐帧写回下游。连接关闭时统一清理：结束上游执行会话、关闭 socket、等待读 pump 与断连订阅者退出。CPA 用 `wsTimelineLog` 在 `request-log` 开启时记录连接上每个请求帧与响应帧——这正是 SSEInspector 录制功能的对应物，说明逐帧录制是该类代理普遍需要的能力。

### 上游 wss 客户端（`internal/runtime/executor/codex_websockets_*.go`）

上游连接由 `CodexWebsocketsExecutor` 管理：拨号时携带 beta 头 `responses_websockets=2026-02-06`、启用 permessage-deflate 压缩、握手超时 30 秒、空闲超时 5 分钟（`codex_websockets_connection.go:28-32`）。每个执行会话（对应一个下游连接）持有一条上游连接，会话内有专职读 goroutine：按帧的 `type` 字段分发，`response.created` 记录活动响应 ID，terminal 事件（`response.completed/failed/incomplete`、`error`）标记该响应结束，帧投递给当前活动轮次的 channel。值得注意：CPA 拨号连接的是 Codex 内部 wss 端点，上游返回的是裸 Responses 事件（无 `message` 信封），因为 CPA 是终止式网关、自行封装下游帧；SSEInspector 面对公共 `/v1/responses` 端点，必须按官方信封格式处理。

CPA 维护双模上游：`upstreamMode=websocket` 时原生 WS 直通（Codex/xAI），否则把 WS 轮次降级为 HTTP `POST /v1/responses` 调用其他供应商。上游已不可用而续轮仍依赖现存连接时，CPA 以 `CloseServiceRestart`（reason：`upstream requires HTTP replay`）关闭连接，通知客户端改走 HTTP 重放完整请求。

### 错误语义分层

CPA 把错误分成三层，每层的连接处置不同，这套分层对透明代理同样适用：

- 请求级错误（`error` 事件、4xx 语义）：发送给客户端但不关闭连接，其他 lane 与后续轮次继续。
- 传输丢失（EOF、异常关闭 1006、ECONNRESET）：包装为 `UpstreamWebsocketTurnError`——下游 socket 保持打开，只报告该轮失败，并以 inputEpoch 栅栏机制（为每个轮次编制递增的纪元编号，连接重建后只认当前纪元内读到的输入）把丢失前读到的输入判为「未发送」，由客户端决定重发。
- 不可继续（消息超限 1009 → `message_too_big`；必须重放）：把上游 close code 原样镜像给下游（`writeWebsocketCloseForUpstreamError`），让客户端按 close code 自行降级（例如回退 SSE）。

## SSEInspector 的处理要点（供后续方案设计）

以下是从本次调研直接推出的实现约束，细节留待设计文档论证：

1. **Express 无法收到 upgrade 请求**：WebSocket 升级不经过中间件栈，必须挂 `http.Server` 的 `'upgrade'` 事件并按路径（`/v1/responses` 的 GET 升级）分流，需要引入 `ws` 依赖。
2. **透明反向代理**：SSEInspector 不终止协议。下游 ws 与上游 wss 双向桥接，请求头（含 `Authorization`、`OpenAI-Beta`、`Sec-WebSocket-Protocol`）尽量原样透传，帧字节原样转发，同时 tee 一份给 Recorder。
3. **录制数据模型**：每个 `response.create` 生命周期（按 lane）对应一条记录，`stream_id` 作为 lane 维度字段；解信封后内层事件流输入给现有 `OpenAIResponsesAccumulator` 得到合并结果，原始帧按 NDJSON（以换行分隔的 JSON）行保存为 raw（与现有 raw SSE 保存原则一致）。
4. **终止与错误判定**：`response.completed/failed/incomplete` 是 terminal（与现有 SSE terminal 判定同构）；`error` 信封是请求级错误，不终结连接记录；连接关闭（任一端）终结该连接上所有未完成记录。
5. **上游 60 分钟寿命**：上游按官方上限断开时，把 close code/reason 原样镜像给下游，不做自动重连（透明代理不引入对客户端隐藏的状态）。

## 参考

- WebSocket 模式指南：<https://developers.openai.com/api/docs/guides/websocket-mode>
- WebSocket 事件参考：<https://developers.openai.com/api/reference/resources/responses/websocket-events>
- 参考实现：`.tmp/CLIProxyAPI`（`sdk/api/handlers/openai/openai_responses_websocket.go`、`internal/runtime/executor/codex_websockets_*.go`、`internal/api/server_routes.go`）
