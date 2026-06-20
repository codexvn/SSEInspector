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
- 数据：TypeORM / SQLite
- SSE 解析：`eventsource-parser`
- 前端：Vite / Vue / Monaco Editor
- Token 统计：`gpt-tokenizer`、`@anthropic-ai/tokenizer` 等

## 常用命令

```bash
# 启动代理和前端
npm start

# 后端 TypeScript 构建
npm run build

# SSE 合并回归测试
npm run test:sse

# 前端构建
cd frontend && npm run build
```

运行时环境变量：

- `UPSTREAM_URL`：上游 API 地址，必填。
- `PORT`：代理端口，默认 `3000`。

## 关键目录和文件职责

```text
backend/src/proxy.ts
```

代理入口，负责上游转发、流式原文缓存、非流式响应记录。修改时必须避免破坏透明代理语义。

```text
backend/src/sse-parser.ts
```

底层 SSE 解析，只负责把 raw SSE 文本解析成 `SSEChunk[]`，不处理 OpenAI / Anthropic 业务语义。

```text
backend/src/sse-merger.ts
```

流式合并门面，保留 `parseSSE` 和 `mergeChunks` 对外 API，内部委托给具体 provider accumulator。

```text
backend/src/stream-accumulators/
```

分层流式合并器：

- `anthropic.ts`：Anthropic Messages 流式事件合并。
- `openai-chat.ts`：OpenAI Chat Completions 流式 chunk 合并。
- `openai-responses.ts`：OpenAI Responses API 流式事件合并。
- `types.ts`：accumulator 公共类型和工具函数。

```text
backend/src/store.ts
```

请求记录持久化、列表摘要、实时更新事件、工具调用查询。

```text
backend/src/token-counter.ts
```

输入 token 拆分、缓存命中统计、API usage 解析。

```text
backend/test/sse-merger.test.ts
```

SSE 合并回归测试。修改 SSE parser 或 accumulator 时必须同步补充测试。

```text
frontend/src/
```

前端页面、组件、store、API 调用和详情展示逻辑。

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

6. Responses API 应优先维护完整 `response.output[]` snapshot，同时保留 UI 便捷字段：

   ```ts
   output_text
   reasoning_text
   tool_calls
   usage
   error
   incomplete_details
   ```

   `response.completed` 是最终权威快照；`response.output_text.done` 应覆盖 delta 文本，不要用长度启发式判断。

7. SSEInspector 是检查器，不是官方 SDK 客户端。面对第三方兼容流时应尽量保留数据，不要因为缺少某个官方字段就丢弃整条响应。

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
