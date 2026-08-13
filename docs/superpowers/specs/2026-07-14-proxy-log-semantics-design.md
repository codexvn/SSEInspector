# 结构化日志与代理语义优化设计

## 目标

使用 Pino 建立统一、结构化、可接入日志平台的后端日志层，同时保留完整、可关联的正常代理生命周期日志，并突出真正需要处理的异常。

## 当前问题

后端运行时当前分散使用 `console.log/warn/error`，字段和错误格式不统一，无法在彩色终端与日志平台 JSON 之间切换。`backend/src/proxy.ts` 在 `res.close` 或 httpxy `econnreset` 时立即打印 `downstream_closed`；此时主线程只知道关闭方向，不知道响应是否已经包含 terminal 事件，因此正常完成和真正提前中断使用同一条误导性文案。

## 设计

### 统一日志层

- 使用 `pino@10.3.1` 和 `pino-pretty@13.1.3`，项目最低 Node.js 版本提升到 20。
- 新增 `backend/src/logger.ts`，提供根 logger、按 component 缓存的 child logger、日志格式解析和完整 Error cause 链序列化。
- 默认 `LOG_FORMAT=pretty`，使用同步 `pino-pretty` stream 输出彩色单行日志；`LOG_FORMAT=json` 时输出标准 Pino NDJSON，供 OpenTelemetry Collector、Grafana Alloy 或其他 agent 采集。
- `LOG_LEVEL` 默认 `info`。非法 format 或 level 在启动阶段明确失败，不静默回退。
- 主线程与 Recorder Worker 读取相同环境配置，各自初始化 logger，不新增 transport Worker，也不改变 Recorder 消息协议。
- Pino 字段使用稳定名称：`component`、`requestId`、`method`、`path`、`target`、`status`、`durationMs`、`reason`、`err`。
- 不直接从应用连接 Loki、Elastic 或其他平台；生产接入通过 JSON stdout → Collector/Agent → OTLP/平台 exporter，避免平台网络或重试影响代理数据面。

### 迁移范围

- `backend/src` 与 `bin` 中运行时 `console.*` 全部迁移，包括 proxy、api、db、recorder、SSE parser、store、accumulators 和 CLI 参数/启动错误。
- `bin/parse-args.js` 改为纯解析函数，返回 options 与 errors，不自行输出；`bin/sse-inspector.js` 在解析 `--dev` 后加载 dev TS 或 prod dist logger，再输出结构化参数错误。
- CLI help 属于命令输出而不是日志，使用 `process.stdout.write()` 输出纯文本，不加 Pino 前缀，也不作为 logger 失败兜底。
- logger 加载、配置或依赖失败时直接由 Node 终止，不保留 console fallback 或第二套 logger。
- 前端浏览器 console 和测试脚本的最终结果输出不属于 Node 服务日志，不在本轮迁移范围内。

### 主线程传输日志

- 请求开始输出一条结构化 info 日志，包含 request ID、method、path 和 target。
- 正常上游 HTTP EOF 输出中性的 `end` info 日志，reason 为 `upstream_complete`。
- `downstream_closed` 输出中性的 `end` info 日志，不使用“客户端连接关闭”或 error 文案。主线程继续通知 Recorder，并立即终止对应上游连接；不改变传输生命周期。
- `request_aborted` 输出 warning，包含 request ID、status、duration 和 target。
- `upstream_aborted`、`upstream_error` 输出 error，包含 request ID、status、duration、target 和完整异常链。
- passthrough 与 AI endpoint 同样生成 UUID 并 capture（见 `docs/superpowers/specs/2026-07-19-passthrough-recording-design.md`）；开始/结束日志必须带真实 `requestId`，不再使用 `id=-`。

### Recorder 语义日志

- Recorder 收到 `downstream_closed` 后，对 AI endpoint 继续使用现有 terminal SSE 判断；透传不做协议 terminal 判断。
- 已包含 terminal 事件：正常保存为 `finished=client_close`、`error=null`；控制台只保留主线程的中性 `end` 日志。
- 缺少 terminal 事件（仅 AI endpoint）：保留主线程的中性 `end` 日志，保存部分响应并额外输出一条 warning，包含 request ID、status、duration 和 `reason=downstream_closed`。
- 已取消 capture 队列 64 MiB 积压截断（无 pending 上限，仅保留每轮 1 MiB drain）；不再存在「因 truncate 跳过 incomplete warning」分支。
- `request_aborted` 的持久化仍不解析未完成请求或空响应。

## 非目标

- 不修改数据库 schema、外部 AI API、内部 REST API 或 Worker 消息协议。
- 不让代理主线程解析 JSON/SSE。
- 不记录请求体、响应体、headers、token 或其他敏感内容。
- 本轮不部署 OpenTelemetry Collector，不新增平台地址、认证或文件日志轮转。

## 验证

- pretty 模式输出 ANSI 彩色 level 和单行字段；JSON 模式每行均为可解析对象。
- 主线程和 Recorder Worker 使用相同 format/level。
- Error 日志保留 name、message、stack 和递归 cause 链。
- 正常上游 HTTP EOF：输出一条 `start` 和一条 `end reason=upstream_complete`。
- terminal SSE 后客户端关闭：输出一条 `start` 和一条 `end reason=downstream_closed`，无 `incomplete` warning，记录仍为正常完成。
- terminal 前关闭：输出中性的 `end`，Recorder 再输出一次 incomplete warning，记录为 error。
- 上传中断：输出一次 request_aborted warning。
- 上游异常：输出一次 error，包含 request ID、status、duration 和异常链。
- 并发请求的 start/error 日志可通过 request ID 关联。
