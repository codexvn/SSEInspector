# SSEInspector 项目说明

## 项目定位

SSEInspector 是 OpenAI / Anthropic API 透明代理检查器，用于记录、合并和展示流式与非流式请求响应。

核心目标：

- 保持代理透明：请求头、响应头和 SSE 数据应尽量原样透传。
- 原样保存 raw SSE：流式响应的原始文本必须保留，方便排查协议兼容问题。
- 合并结果用于检查和展示：`responseContent` 是便于 UI 展示和分析的合并结果，不应替代原始响应。
- 兼容多供应商：需要兼容 OpenAI-compatible、Anthropic-compatible、GLM、vLLM、私有网关等变体，不能只按官方 SDK 严格类型处理。

## 技术栈

- 后端：TypeScript + Express
- 代理传输：`httpxy`
- 数据：TypeORM / SQLite
- SSE 解析：`eventsource-parser`
- 前端：Vite / Vue / Monaco Editor
- Token 统计：仅使用上游 API usage，不做本地 tokenizer 重算
- 日志：Pino / pino-pretty，默认彩色单行输出，可切换为 NDJSON

## 常用命令

```bash
# 启动代理和前端（开发模式，需 CLI 参数）
npm start -- --upstream http://localhost:8000 --db-path ./data.db

# 后端 TypeScript 构建
npm run build

# 前端构建
npm run build:frontend

# 后端 + 前端全量构建（打包发布前）
npm run build:all

# SSE 合并回归测试
npm run test:sse

# 请求体解码（gzip/deflate/br/zstd）纯函数测试
npm run test:decode

# 记录身份（AI / passthrough）解析测试
npm run test:identity

# 透传 store 读写 / filter / counts 测试
npm run test:passthrough-store

# 代理数据面字节透传与 Recorder Worker dev/prod 测试
npm run test:proxy
npm run test:worker

# 日志与 CLI 输出测试
npm run test:logger
npm run test:cli-logging

# endpoint、preview、工具配对、透传记录和前端响应映射全量测试
npm run test:all
```

## 运行方式

### 生产模式（npx / 打包产物，推荐）

```bash
# 通过 GitHub Release tarball 直接运行
npx https://github.com/codexvn/SSEInspector/releases/download/v1.0.0/sse-inspector-v1.0.0.tgz \
  --upstream http://localhost:8000 --db-path ./data.db

# 本地构建产物直接运行
npm run build:all
node bin/sse-inspector.js --upstream http://localhost:8000 --db-path ./data.db
```

CLI 参数：

- `--upstream <url>`：上游 API 地址，必填。
- `--port <n>`：监听端口，默认 `3000`。
- `--db-path <path>`：SQLite 数据库路径，必填，无默认值。
- `--dev`：开发模式，同进程 tsx 加载 TS 源码并启用前端 HMR（`npm start` 已内置）。
- `-h, --help`：显示帮助。

### 开发模式（tsx + HMR）

```bash
npm start -- --upstream http://localhost:8000 --db-path ./data.db
```

`npm start` 等价于 `node bin/sse-inspector.js --dev`：同进程用 tsx 加载 `backend/src` TS 源码，前端 HMR 由 vite-express 提供。配置统一由 CLI 参数经 `setConfig` 填充，不再使用环境变量回退。

运行时要求 Node.js 20.19+ 或 22.12+，与 Vite 8 的 engine 约束一致，不支持 Node.js 21。日志环境变量：

```bash
LOG_FORMAT=pretty  # 默认，彩色单行终端日志
LOG_FORMAT=json    # Pino NDJSON，供 Collector/Agent 采集
LOG_LEVEL=info     # 默认日志级别
```

非法 `LOG_FORMAT` 或 `LOG_LEVEL` 会在启动阶段失败，不使用静默回退。应用不直接连接 Loki、Elastic 等平台；需要集中采集时使用 JSON stdout，经 OpenTelemetry Collector、Grafana Alloy 或其他 Agent 转发。

## 打包与发布

项目以 GitHub Release tarball 分发（不发 npm）。打包由 `package.json` 的 `files` 白名单 + `frontend/.npmignore` 控制，最终 tarball 含 `bin/`、`dist/`、`frontend/dist/`、`README.md`、`LICENSE`。

发布流程：

```bash
git tag v1.0.0
git push origin v1.0.0
```

`.github/workflows/release.yml` 在 push `v*` tag 时自动触发，构建后端 + 前端，`npm pack` 生成 tarball 并上传到 GitHub Release，文件名为 `sse-inspector-v1.0.0.tgz`。

`better-sqlite3` 是原生模块，用户 `npx` 时由 npm 自动安装并下载预编译二进制；非 LTS Node 版本或小众平台可能触发 node-gyp 编译，需 Python3 + C++ 工具链。

## 关键目录和文件职责

```text
backend/src/proxy.ts
```

代理数据面入口。`httpxy` 是 request/response pipe、HTTP 背压、headers、keep-alive 和双向 socket 销毁的唯一所有者；禁止重新引入手写 `http.request`、`res.write` 循环或 `selfHandleResponse`。

已注册 AI endpoint（`handleProxy`）与未注册路径透传（`handlePassthrough`）共用同一 `forward()` capture 管线：均生成 UUID、`beginCapture`，并 tee 请求体、观察响应体后落库。透传 metadata 固定为 `apiType/apiEndpoint=passthrough`；仍排除现有 catch-all 规则（`/api/*`、`/`、带扩展名的 GET 静态资源）。日志 label 区分 `proxy` / `passthrough`，二者开始/结束日志都必须带真实 `requestId`（不再使用 `'-'`）。

被记录请求通过原生 `Transform` tee 传给 `httpxy.buffer`，确保首个已缓冲请求 chunk 不会被观察监听器提前消费。请求/响应 chunk 与生命周期控制消息进入同一个有序延迟队列，实际 Buffer 复制和 Worker `postMessage` 在后续事件循环执行，每轮最多复制 1 MiB（`MAX_CAPTURE_DRAIN_BYTES`）。**无 pending 字节上限、无 truncate**：取消原 64 MiB 积压截断后，Worker 慢或大体量并发时主线程队列可无限增长，存在 OOM 风险；1 MiB drain 只保护事件循环。主线程不访问数据库、不解析 JSON/SSE、不计算 token。非流式响应保持原始状态码、headers 和 body 字节，不经过 JSON 重编码。

客户端先关闭时只记录 `downstream_closed` / `request_aborted`，由 `httpxy` 负责终止上游连接；上游异常才打印转发失败。正常 `upstream_complete` 与 `downstream_closed` 都输出中性的 `proxy request ended` info 日志，`request_aborted` 输出 warning，`upstream_aborted` / `upstream_error` 输出 error。AI endpoint 的 Recorder 根据 terminal SSE 判断 `client_close` 是完整结果还是部分错误；缺少 terminal 时额外输出一次 `captured response is incomplete` warning。透传不做协议 terminal 判断，不因缺 terminal 打 AI 专用 incomplete 语义。`request_aborted` 只持久化中断状态和已捕获原始响应字节，不解析未完成请求或空响应。开始日志包含 request ID、method、path、target，结束日志包含 request ID、status、duration 和 reason。

```text
backend/src/recorder/client.ts
backend/src/recorder/protocol.ts
backend/src/recorder/worker.ts
bin/recorder-worker.js
```

Recorder 观察面：`client.ts` 管理 Worker 生命周期、RPC、UI 事件与延迟 capture 队列（每轮 1 MiB drain，无 pending 上限）；`protocol.ts` 定义强类型消息（已删除 `capture.truncated`）；`worker.ts` 是 TypeORM、SQLite、SSE 合并、usage、preview 和工具配对的唯一运行时所有者。`apiEndpoint === passthrough` 时 Worker 短路：不 mergeChunks / 不写 usage / 不写 tool_calls / 不做 terminal SSE 判断；请求体可 decode 为 JSON 或 UTF-8 文本回退，响应始终保留完整 raw。Worker 异常退出时代理继续透传，内部数据库 API 返回 503，并按 1 秒、2 秒、5 秒退避自动恢复。dev 使用 tsx CJS bootstrap，prod 加载 `dist/recorder/worker.js`。

进程关闭时先停止 HTTP Server 接收新连接，并立即停止向 Recorder 投递新捕获和 RPC。Worker 获得最多 4 秒优雅收尾时间，随后最多 1 秒强制终止；从收到 SIGINT/SIGTERM 起总退出时间严格不超过 5 秒。

```text
backend/src/body-decode.ts
```

请求体解码纯函数：按单一 `content-encoding` 头解压（identity / gzip / deflate / br / zstd）并 `JSON.parse`，供检查器使用。失败只返回 error 不抛，绝不阻塞代理透传。单测见 `backend/test/body-decode.test.ts`。

```text
backend/src/config.ts
```

中央运行时配置容器。由 CLI 入口 `bin/sse-inspector.js` 在启动时通过 `setConfig()` 填充，被 `index.ts` / `proxy.ts` / `db/index.ts` 读取。dev / prod 均走 config，不再有环境变量回退。

```text
backend/src/logger.ts
```

Node 运行时唯一日志入口。根 logger 固定包含 `service=sse-inspector`，各模块通过缓存的 component child logger 输出结构化字段。`backend/src` 与 `bin` 禁止直接使用 `console.log/warn/error`；CLI help 属于命令输出，使用 `process.stdout.write()`。异常字段必须通过统一序列化保留 type、message、stack 和递归 cause 链。慢 SQL 只输出耗时与 SQL，不输出参数或查询结果。

```text
tsconfig.json
```

后端 TS 编译配置。`module` / `moduleResolution` 使用 `node16`，使 CommonJS 项目能够保留原生动态 `import()` 加载 ESM-only 的 `httpxy`；其余后端输出仍是 CommonJS。`lib` 显式为 `["es2022"]`（不含 DOM）。

```text
bin/sse-inspector.js
```

CLI 入口（CJS，不经 tsc），带 shebang。解析 `--upstream` / `--port` / `--db-path` / `--dev` 参数（`parseArgs` / `getHelpText` 抽自 `bin/parse-args.js`），填充 config 后加载入口启动。参数错误使用同一 Pino logger；help 使用纯 stdout。dev / prod 合一：`--dev` 同进程 tsx 加载 `backend/src` TS 源码（tsx 惰性 require，prod 路径不执行），否则 `require` 编译产物 `dist/`。`npx` 直跑与 `npm start` 共用此入口。

```text
backend/src/sse-parser.ts
```

底层 SSE 解析，只负责把 raw SSE 文本解析成 `SSEChunk[]`，不处理 OpenAI / Anthropic 业务语义。

```text
backend/src/types.ts
backend/src/record-identity.ts
```

`ApiType` / `ApiEndpoint` / `RequestListFilter` 使用 `as const` 对象 + 派生联合类型（不用 TypeScript `enum`），含 `passthrough`。运行时比较优先常量（如 `ApiType.Passthrough` / `ApiEndpoint.Passthrough`）。`resolveRecordIdentity` 是记录身份的单一入口：透传要求 `apiType` 与 `apiEndpoint` 同时为 `passthrough`，不调用 `resolveEndpoint(path)`；AI 走 path↔endpoint 一致性校验。

```text
backend/src/endpoints.ts
```

AI endpoint 唯一注册表。路由、provider、accumulator factory 都从这里派生。当前只注册 `openai-chat`、`openai-responses`、`anthropic-messages`；未知 path 走透传 capture（`apiType/apiEndpoint=passthrough`），不得默认回退 Chat。

```text
backend/src/sse-merger.ts
```

流式合并门面。公共接口固定为 `parseSSE(rawText)` 与 `mergeChunks(chunks, endpoint)`；endpoint 必填并使用穷尽分支，禁止通过 SSE 内容猜测协议。透传不得调用 merge。

```text
backend/src/stream-accumulators/
```

分层流式合并器：

- `anthropic.ts`：Anthropic Messages 流式事件合并。
- `openai-chat.ts`：OpenAI Chat Completions 流式 chunk 合并。
- `openai-responses.ts`：OpenAI Responses API 流式事件合并。
- `types.ts`：accumulator 公共类型和工具函数。

```text
backend/src/entity/RequestEntity.ts
backend/src/store.ts
```

请求记录持久化、列表摘要、实时更新事件、工具调用查询。实体表含必填 `api_endpoint` 列，写入时同时落 `api_type` 与 `api_endpoint`。**读路径以 `api_endpoint`（及 `api_type`）为准**，path 仅展示与搜索，不承担协议分发或 endpoint 反推。`getAll` / stats counts 结构为 `{ openai, anthropic, passthrough, streaming, error }`。生产运行时仅允许 Recorder Worker 导入 store；Express 主线程通过 Worker RPC 查询，不得直接调用 store。

```text
backend/src/protocol-content.ts
backend/src/tool-calls.ts
```

无数据库依赖的协议内容 helper：统一提取多文本块、最新可读 message、最新 user message，以及按 endpoint 提取工具调用和下一轮工具结果。Responses 工具配对优先使用 `call_id`，`id` 仅作为明确标记的非标准 fallback。透传不参与工具配对。

SQLite 数据仅作为一次性检查记录，不维护 schema migration。TypeORM 通过 entity 与 `synchronize: true` 创建或同步当前 schema；实体结构发生不兼容变化时直接删除旧 DB 重建，不承诺历史数据迁移。启动阶段不扫描历史 requests 数据；AI 记录的 endpoint/provider 一致性在新记录写入和读取时经 `resolveRecordIdentity` / Endpoint Registry 校验，透传跳过 path 注册表。

`backend/src/db/slow-query-logger.ts` 负责慢 SQL 日志。执行时间超过 200ms 时只输出耗时和 SQL 文本，不输出绑定参数或查询结果，避免大型请求/响应字段的日志序列化阻塞 Recorder Worker。

```text
backend/src/api-usage.ts
```

API usage 写入及 endpoint 专属 input/output/cache token 提取。只有非 null 对象允许序列化入库；`usage: null` 表示尚无 usage，必须写为 SQL NULL。禁止为未知模型回退本地 tokenizer；完成后的 tok/s 只使用上游 `output_tokens / duration`。

```text
frontend/src/context-composition.ts
frontend/src/workers/request-analysis.worker.ts
```

详情页上下文组成分析。Worker 解析原始 request body，提取最新用户消息和请求摘要，并按 Instructions、User、Assistant、工具定义、工具交互、附件、其他计算 UTF-8 字节占比。该比例不代表模型 token；正常进入详情页时禁止在主线程同步解析大型请求体。

```text
backend/test/sse-merger.test.ts
```

SSE 合并回归测试。修改 SSE parser 或 accumulator 时必须同步补充测试。

```text
backend/test/body-decode.test.ts
```

请求体解码纯函数测试（identity / gzip / deflate / br / zstd / 损坏数据 / 非 JSON / 未知编码 / 多值降级 / 大小写空格归一化 / 空 body）。

```text
frontend/src/
```

前端页面、组件、store、API 调用和详情展示逻辑。API 返回的 `apiEndpoint` 为必填字段，前端不得再从 path 或 provider 推断协议；透传使用 `ApiEndpoint.Passthrough` / 灰色「透传」徽章，列表顶栏顺序为 `总计 · OpenAI · Anthropic · 透传 · 进行中 · 错误`。`DetailView` 对透传走 raw inspector（headers + body 原始/美化），不启动协议合并、MessageFlow、工具配对或上下文组成分析。`response-flow.ts` 将规范化 AI 响应转换为卡片 descriptor，模型工具调用卡片不内联 result，结果仅通过 hover 使用现有工具配对接口加载。完整工具历史只在 `MessageFlow` 展示；`DetailView` 对每条 request body 只解析一次，会话前后记录只在导航、diff 或 MessageFlow 操作时加载，请求体和响应体 Monaco 只在对应折叠区及 tab 打开时挂载。

## 流式合并维护规则

修改以下文件时，必须优先考虑回归测试：

- `backend/src/sse-parser.ts`
- `backend/src/sse-merger.ts`
- `backend/src/stream-accumulators/*`
- `backend/src/types.ts` 中的流式响应类型

维护原则：

1. 修改 SSE parser / accumulator 后，必须运行：

   ```bash
   npm run test:sse
   npm run build
   ```

2. Anthropic `message_delta.usage` 是累计 usage，应整体合并并保留缓存字段。

   不要只合并：

   ```ts
   output_tokens
   ```

   需要保留：

   ```ts
   input_tokens
   output_tokens
   cache_creation_input_tokens
   cache_read_input_tokens
   service_tier
   server_tool_use
   ```

   以及供应商扩展字段。

3. OpenAI-compatible 供应商可能返回官方类型之外的字段，例如：

   ```ts
   reasoning_content
   ```

   合并器应尽量保留有用扩展字段，避免过度收窄类型。

4. Anthropic 合并需要保留引用、thinking 签名和未知块：

   ```ts
   citations
   signature
   redacted_thinking
   _raw
   _deltas
   ```

5. OpenAI Chat 合并需要兼容旧版函数调用和安全字段：

   ```ts
   function_call
   refusal
   logprobs
   prompt_filter_results
   content_filter_results
   ```

6. Responses API 以完整 `response.output[]` snapshot 为唯一输出事实源，并在 finalize 时派生 UI 便捷字段：

   ```ts
   output_text
   reasoning_text
   tool_calls
   usage
   error
   incomplete_details
   ```

   lifecycle response 的所有非 `undefined` 顶层字段都必须保留（包括 `null` 与供应商扩展字段）。terminal `output` 为数组时是最终权威快照；为 `null`、缺失或非法结构时不得清空已累计 item。content、reasoning summary、tool input 的 done 状态必须按具体 index 维护，不得使用 response 级全局布尔值。

7. `response.metadata` 是已观察到的私有 auxiliary 事件，不合并进官方 `Response.metadata`，不生成普通消息卡；原始内容仅保存在 raw SSE。其他没有 snapshot 语义的未知事件同样不污染合并响应。

8. SSEInspector 是检查器，不是官方 SDK 客户端。面对第三方兼容流时应保留未知 response 字段和未知 output item，并在 UI 使用 Raw JSON 卡展示；未知事件不得用于 endpoint 推断。

## 官方 SDK 对照原则

当前项目不把 OpenAI / Anthropic 官方 SDK 作为 git submodule 放入项目，也不复制官方源码 snapshot。

原因：

- submodule 会增加 clone、CI、IDE、CodeGraph 成本。
- 官方 SDK 仓库体积和历史较大，而本项目只需要少量 streaming accumulator 规则。
- submodule 容易引入搜索噪音，增加误改或误 import 风险。
- submodule 更新流程比文档链接更重。

规则：

- 不在生产路径直接 import OpenAI / Anthropic SDK 内部 helper。
- 官方 SDK 源码只作为语义参考。
- 后续升级协议时，先对照官方文档和 SDK 源码，再更新 fixture 测试，最后修改 accumulator。
- 如果需要离线源码对照，必须先征得用户确认，不要自行新增 `vendor/`、`.gitmodules` 或源码 snapshot。

常用对照链接：

- Anthropic MessageStream：<https://unpkg.com/@anthropic-ai/sdk@0.39.0/src/lib/MessageStream.ts>
- Anthropic Streaming Messages 文档：<https://platform.claude.com/docs/claude/reference/messages-streaming>
- OpenAI ChatCompletionStream：<https://unpkg.com/openai@5.2.0/lib/ChatCompletionStream.mjs>
- OpenAI ResponseStream：<https://unpkg.com/openai@5.2.0/lib/responses/ResponseStream.mjs>
- OpenAI Chat streaming API：<https://platform.openai.com/docs/api-reference/chat-streaming?lang=node.js>
- OpenAI Responses streaming events：<https://platform.openai.com/docs/api-reference/responses-streaming>

## 日志和异常规则

遵循用户全局偏好：

- 所有 UI 文案、注释、文档使用简体中文。
- 项目代码中的标识符保持英文。
- 后端与 CLI 统一使用 `backend/src/logger.ts` 的 Pino logger，不保留 console 或第二套 fallback logger。
- 稳定字段名包括 `component`、`requestId`、`method`、`path`、`target`、`status`、`durationMs`、`reason`、`err`。
- catch 块不得静默吞异常。
- 日志应包含异常类型、message、cause 链。
- 不得残留 `[CCGUI_DEBUG_]` 临时调试日志。
- 添加临时调试日志前，应先向用户确认卡片号或简短标识符。

## Git 与提交规则

- 未经用户明确允许，不得执行 `git commit`。
- commit 信息必须使用简体中文，遵循 Conventional Commits 格式。
- 当前项目记忆显示：提交无需任务卡片号。
- 提交前必须检查敏感信息、调试日志残留、catch 块、diff 噪音。

## 文档同步规则

修改代码后需要判断是否同步更新本文件：

- 新增/删除/重命名关键目录或文件。
- 新增/修改端口、服务、协议。
- 修改 SSE 合并架构或 provider accumulator 职责。
- 新增测试命令、构建命令或开发规范。

## 设计文档

- `docs/superpowers/specs/2026-07-14-proxy-log-semantics-design.md`：结构化日志与代理关闭语义设计。
- `docs/superpowers/plans/2026-07-14-proxy-log-semantics.md`：Pino 全量迁移实施计划与验证清单。
- `docs/superpowers/specs/2026-07-17-streaming-empty-placeholder-design.md`：流式等首包阶段占位展示设计。
- `docs/superpowers/plans/2026-07-17-streaming-empty-placeholder.md`：流式等首包占位实施计划。
- `docs/superpowers/plans/2026-07-19-body-raw-and-blobs.md`：请求体原始展示与二进制处理实施计划。
- `docs/superpowers/specs/2026-07-19-passthrough-recording-design.md`：透传请求记录、`api_endpoint` 列与取消 64 MiB 截断设计。
- `docs/superpowers/plans/2026-07-19-passthrough-recording.md`：透传记录与筛选实施计划。
