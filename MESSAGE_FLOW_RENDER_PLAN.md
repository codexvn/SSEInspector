# 消息流卡片渲染重构计划

## 背景

当前消息流入口位于 `frontend/src/views/DetailView.vue`，弹窗内使用 `MessageFlow` 渲染 `parsedBody`。`MessageFlow` 目前只接收 `apiType`，并在同一段解析逻辑里混合处理 `messages` 与 `input`，导致 OpenAI Chat、OpenAI Responses、Anthropic Messages 三种协议格式无法被准确区分。

已知问题：

- 消息流渲染异常：不同接口格式的数据块被混合解析，部分块类型无法正确展示。
- 多个卡片存在重叠风险：卡片宽度、长文本、代码块和弹窗布局约束不足。
- 消息流整体滚动体验不稳定：弹窗外层有滚动，但内部组件缺少明确的尺寸、溢出和长内容处理。
- 协议特化逻辑散落在通用解析中，不利于继续支持不同块类型。

## 目标

- 按请求 URL 判断内容格式，不再只依赖 `apiType` 或 body 形状推断协议。
- 按协议格式解析数据，再归一成统一的展示模型。
- 先重构详情页现有展示卡片，再让消息流复用同一套卡片组件。
- 统一卡片视觉结构，协议差异只体现在解析器和块类型映射中，不在详情页和消息流中重复实现。
- 梳理 API 类型命名：供应商维度使用 `ApiProvider`，端点协议维度使用 `ApiEndpoint`。
- 修复卡片重叠和消息流不可滚动问题。
- 保持现有详情页、消息流弹窗入口和基础交互不变。

## API 类型命名调整

当前后端存在两个 union 类型：

```ts
export type ApiType = 'openai' | 'anthropic'
export type ApiEndpoint = 'openai-chat' | 'openai-responses' | 'anthropic-messages'
```

两者语义不同：

- `ApiType` 实际表达供应商维度。
- `ApiEndpoint` 表达端点协议维度。

为避免“type”同时被理解为供应商和协议格式，建议后续重命名：

```ts
export type ApiProvider = 'openai' | 'anthropic'
export type ApiEndpoint = 'openai-chat' | 'openai-responses' | 'anthropic-messages'
```

迁移策略：

- 将 `RecordedRequest.apiType`、`RecordSummary.apiType` 保持兼容，先不改数据库字段名 `api_type`。
- TypeScript 层逐步把 `ApiType` 改名为 `ApiProvider`。
- 后端路由传递 `{ provider, endpoint }` 或分别传入 `provider`、`endpoint`。
- 前端展示仍可显示为 API 类型，但内部判断协议时只使用 `ApiEndpoint` 或 URL/path 识别结果。

Usage 类型也应按 `ApiEndpoint` 拆分，避免不同协议字段混入同一个 interface：

```ts
interface OpenAIChatUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: {
    cached_tokens?: number
    cache_miss_tokens?: number
  }
}

interface OpenAIResponsesUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  input_tokens_details?: {
    cached_tokens?: number
  }
  output_tokens_details?: {
    reasoning_tokens?: number
  }
}

interface AnthropicMessagesUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  service_tier?: string
}
```

`cache_creation_input_tokens`、`cache_read_input_tokens` 属于 Anthropic Messages 语义，不应继续放在 `OpenAIResponsesUsage` 中。

## 协议格式识别

新增前端协议识别逻辑，输入优先使用 `record.path`，必要时使用 `record.upstreamUrl` 兜底。

协议格式应复用 `ApiEndpoint`，不要再定义一套重复的端点字符串。前端识别函数只在无法匹配 URL/path 时额外返回 `unknown`：

```ts
type MessageFlowFormat = ApiEndpoint | 'unknown'
```

识别规则：

- URL/path 以 `/chat/completions` 结尾：`openai-chat`
- URL/path 以 `/responses` 结尾：`openai-responses`
- URL/path 以 `/messages` 结尾：`anthropic-messages`
- 其他情况：`unknown`

`DetailView.vue` 向 `MessageFlow` 传入完整记录或显式传入 `path/upstreamUrl`，避免 `MessageFlow` 只能看到 `apiType`。

## 卡片组件重构策略

实施顺序应先从详情页开始，而不是先重写消息流。当前详情页已经有相对完整的响应、思考、工具调用、工具结果展示逻辑，消息流应复用这些卡片能力。

推荐顺序：

1. 从 `DetailView.vue` 中抽出现有展示卡片。
2. 保持详情页视觉和行为基本不变，先完成组件化。
3. 消息流解析协议数据后，输出卡片组件需要的 props。
4. 消息流复用详情页卡片组件渲染，而不是维护另一套卡片模板。

建议抽取的组件：

- `BaseTextCard`：文本类卡片底层组件，负责文本内容、Markdown 渲染、折行、复制、折叠和基础布局。
- `SystemMessageCard`：展示 system / instructions 内容。
- `UserMessageCard`：展示用户输入内容。
- `AssistantTextCard`：展示 assistant 正文回答。
- `AssistantThinkingCard`：展示 thinking / reasoning 内容。
- `ToolCallRequestCard`：展示工具调用请求，优先复用或改造现有 `ToolCallCard`。
- `ToolCallResultCard`：展示工具调用结果，支持 hover 显示对应请求。
- `RawJsonCard`：展示未识别结构化数据，内部复用 `JsonViewer`。
- `MessageMetaCard`：展示模型、温度、max_tokens、tools 数量等元信息。
- `ToolsListCard`：展示工具列表，默认折叠并懒渲染完整 schema，避免大工具定义影响页面性能。

组件复用原则：

- 详情页和消息流使用同一套卡片组件。
- 卡片组件只关心展示 props，不读取原始协议数据。
- 协议解析逻辑只负责把原始数据转换成组件 props。
- 文本类卡片共享底层 `BaseTextCard`，但对外组件按语义拆分。
- `BaseTextCard` 支持安全 Markdown 渲染，并保留纯文本回退模式。
- 工具调用请求和工具结果保持拆分渲染，便于复用和保留时间线顺序。

## 消息流展示模型

消息流不再维护自己的块展示体系。协议解析器应输出“卡片描述符”，消息流只负责按时间线编排这些卡片，并把 props 传给详情页抽出的可复用卡片组件。

建议模型：

```ts
type MessageFlowCardType =
  | 'system_message'
  | 'user_message'
  | 'assistant_text'
  | 'assistant_thinking'
  | 'tool_call_request'
  | 'tool_call_result'
  | 'message_meta'
  | 'tools_list'
  | 'raw_json'

interface MessageFlowCardDescriptor {
  id: string
  type: MessageFlowCardType
  timestampOrder: number
  props:
    | SystemMessageCardProps
    | UserMessageCardProps
    | AssistantTextCardProps
    | AssistantThinkingCardProps
    | ToolCallRequestCardProps
    | ToolCallResultCardProps
    | MessageMetaCardProps
    | ToolsListCardProps
    | RawJsonCardProps
  pairKey?: string
  toolCallId?: string
}
```

卡片类型到组件的映射：

- `system_message` -> `SystemMessageCard`，内部复用 `BaseTextCard`。
- `user_message` -> `UserMessageCard`，内部复用 `BaseTextCard`。
- `assistant_text` -> `AssistantTextCard`，内部复用 `BaseTextCard`，默认启用 Markdown。
- `assistant_thinking` -> `AssistantThinkingCard`，内部复用 `BaseTextCard`，默认保留原始性。
- `tool_call_request` -> `ToolCallRequestCard`，复用或改造现有 `ToolCallCard`。
- `tool_call_result` -> `ToolCallResultCard`。
- `message_meta` -> `MessageMetaCard`。
- `tools_list` -> `ToolsListCard`，默认只渲染工具摘要，展开后再渲染完整 schema。
- `raw_json` -> `RawJsonCard`，内部复用 `JsonViewer`。

编排规则：

- 消息流按 `timestampOrder` 或解析顺序排列卡片。
- 工具调用请求和工具结果保持独立卡片，使用 `toolCallId` / `pairKey` 建立 hover 配对。
- 未识别协议块不新增专门组件，统一映射为 `raw_json`。
- 消息流模板只做 `type -> component` 分发，不直接读取 OpenAI/Anthropic 原始字段。

## 富文本渲染策略

所有文本类卡片都应支持统一的富文本渲染能力，包括 Markdown、代码块、数学公式和 Mermaid 图。渲染能力必须集中在 `BaseTextCard` 内实现，避免各卡片重复处理。

建议策略：

- `SystemMessageCard`、`UserMessageCard`、`AssistantTextCard`、`AssistantThinkingCard` 全部通过 `BaseTextCard` 渲染文本。
- `BaseTextCard` 默认启用 Markdown 渲染，同时保留“原文”视图，便于查看未经渲染的内容。
- 支持 fenced code block，并保留语言标识。
- 支持行内公式和块级公式，例如 `$...$`、`$$...$$`。
- 支持 Mermaid fenced block，例如 <code>```mermaid</code>。
- Markdown、公式和 Mermaid 输出必须经过安全处理，不直接对未净化的模型内容使用 `v-html`。
- Mermaid 渲染需要禁用不安全能力，避免外链脚本、HTML 注入和危险交互。
- 代码块、表格、长链接需要有横向滚动或自动换行，不能撑破卡片。
- 渲染失败时降级显示原文，不能导致整张卡片空白或报错。

## 协议解析方案

解析原则：

- 输入数据读取由各 API endpoint 自己负责。
- OpenAI Chat、OpenAI Responses、Anthropic Messages 分别读取自己的协议字段。
- 解析器输出统一的 `MessageFlowCardDescriptor[]`，不把协议字段直接暴露给模板。
- 模板只根据 `MessageFlowCardDescriptor.type` 选择详情页复用卡片组件。
- 工具调用请求和工具结果分别输出为 `tool_call_request`、`tool_call_result`，再通过 `toolCallId` 建立配对关系。
- 任意协议中的未知 item/block/component 都不能丢弃，必须退化为 `raw_json` 卡片，并保留原始字段。

### OpenAI Chat

输入格式来源：`body.messages`。

支持内容：

- `system/user/assistant/tool` role。
- `content` 为字符串。
- `content` 为数组时，按块解析 `text`、`input_text`、`image_url` 等可识别结构，未知块保留 JSON。
- assistant 的 `tool_calls` 解析为 `tool_call_request`。
- tool 消息解析为 `tool_call_result`，优先展示 `tool_call_id`。
- 未识别的 message 字段、content block 或 tool_call 结构退化为 `raw_json`。

### OpenAI Responses

输入格式来源：`body.input`、`body.instructions`、`body.tools`。

支持内容：

- `instructions` 渲染为 system 卡片。
- `input` 为字符串时渲染为 user 卡片。
- `input` 为数组时按 item 类型解析：
  - `message`：按 role 和 content 块渲染。
  - `function_call`：渲染为 `tool_call_request`。
  - `function_call_output`：渲染为 `tool_call_result`。
  - `custom_tool_call`：渲染为 `tool_call_request`，保留 `id/call_id/name/input/status` 等字段。
  - 带有 `role/phase/status` 的 assistant 过程项：按字段语义优先渲染为 assistant 文本、thinking 或工具调用过程；无法识别时保留为 `raw_json`。
  - 其他类型：保留 JSON 块。
- `text` 配置和 `tools` 放入 meta/tools 卡片，展示概要和关键字段。
- `tools` 列表单独输出为 `tools_list` 卡片，不塞进 `message_meta`。
- 未识别的 input item、output item、content block 或事件片段退化为 `raw_json`。

### Anthropic Messages

输入格式来源：`body.system`、`body.messages`、`body.tools`。

支持内容：

- `system` 字符串或数组块。
- `messages[].content` 字符串或数组块。
- Anthropic 块类型：
  - `text`：文本块。
  - `thinking`：思考块。
  - `tool_use`：渲染为 `tool_call_request`，展示 `id/name/input`。
  - `tool_result`：渲染为 `tool_call_result`，展示 `tool_use_id/content`。
  - 其他类型：保留 JSON 块。
- 未识别的 content block、system block 或 message 字段退化为 `raw_json`。

## 组件拆分

建议将 `MessageFlow.vue` 内部逻辑拆为三层：

- `detectMessageFlowFormat(record)`：根据 URL/path 识别协议格式。
- `buildMessageFlowItems(body, format)`：协议分发入口。
- 协议解析器：
  - `buildOpenAIChatFlow(body)`
  - `buildOpenAIResponsesFlow(body)`
  - `buildAnthropicMessagesFlow(body)`
- 展示组件分发：
  - `MessageFlowCard`：负责消息流主卡片布局。
  - `MessageFlowComponent`：根据 `FlowComponent.type` 选择具体展示。
  - `BaseTextCard`：负责文本内容的基础渲染能力。
  - `SystemMessageCard`：详情页和消息流共用，展示 `system`。
  - `UserMessageCard`：详情页和消息流共用，展示 `user`。
  - `AssistantTextCard`：详情页和消息流共用，展示 `assistant_text`。
  - `AssistantThinkingCard`：详情页和消息流共用，展示 `assistant_thinking`。
  - `ToolCallRequestCard`：详情页和消息流共用，展示 `tool_call_request`。
  - `ToolCallResultCard`：详情页和消息流共用，展示 `tool_call_result`。
  - `RawJsonCard`：详情页和消息流共用，展示 `raw_json/unknown`。
  - `ToolsListCard`：详情页和消息流共用，展示工具列表并懒渲染 schema。

如当前阶段希望控制改动范围，可先放在 `MessageFlow.vue` 同文件内；确认稳定后再拆到 `frontend/src/utils/message-flow.ts`。

## 布局与滚动修复

弹窗布局：

- `.diff-modal` 保持 `display:flex; flex-direction:column; overflow:hidden`。
- `.flow-body` 明确设置 `min-height:0; overflow:auto; padding`。
- `MessageFlow` 根节点设置 `min-width:0; max-width:100%`。

卡片布局：

- `.msg-card` 必须有明确边框、背景、圆角和 `overflow:hidden`。
- `.msg-item` 使用正常文档流，不使用会造成堆叠的绝对定位。
- 时间线圆点可以保留伪元素，但不得影响卡片布局。
- 长文本、长 JSON 和长工具参数必须设置 `overflow:auto` 或 `word-break`，不能撑破弹窗。
- 移动端降低 padding，并保证卡片宽度不超过容器。

滚动策略：

- 整个消息流只在弹窗主体滚动。
- 单个超长 JSON/代码块可在块内部横向滚动。
- 避免每张卡片单独纵向滚动，除非是非常长的 JSON 块。
- 工具列表默认只显示工具名、描述和数量；完整 schema 仅在展开对应工具时渲染。

## 实施步骤

1. 从 `DetailView.vue` 抽取可复用卡片组件，保持详情页现有展示不变。
2. 改造或包装现有 `ToolCallCard`，形成 `ToolCallRequestCard`。
3. 新增 `BaseTextCard`、`ToolCallResultCard`、`SystemMessageCard`、`UserMessageCard`、`AssistantTextCard`、`AssistantThinkingCard`、`RawJsonCard`、`MessageMetaCard`、`ToolsListCard`。
4. 在 `MessageFlow` 调用处传入 `record.path` 或完整 `record`。
5. 在消息流组件内新增 URL/path 格式识别。
6. 引入统一 `FlowItem/FlowComponent` 模型。
7. 将现有混合解析逻辑拆成三类协议解析器。
8. 消息流模板改为复用详情页卡片组件。
9. 建立工具调用请求和结果的配对索引，用于 hover 显示对应请求/返回。
10. 调整弹窗和卡片 CSS，修复重叠和滚动。
11. 用三类接口样例分别验证：
   - OpenAI Chat：普通消息、tool_calls、tool result。
   - OpenAI Responses：instructions、input message、function_call、function_call_output。
   - Anthropic Messages：system、text、thinking、tool_use、tool_result。
12. 运行 `npm run build`。

## 验证重点

- `/chat/completions`、`/responses`、`/messages` 三类请求都能进入正确解析器。
- 未识别块不会丢失，至少以 JSON 形式显示。
- 多卡片不重叠。
- 弹窗内容可纵向滚动。
- 长文本和长 JSON 不撑破页面。
- 现有详情页响应展示不受影响。
- 详情页和消息流复用同一套文本、工具请求、工具结果、原始 JSON 卡片组件。
- hover 工具调用请求时能看到对应结果摘要；hover 工具结果时能看到对应请求参数。
- 大工具列表默认折叠时不渲染完整 schema，展开单个工具后才渲染对应 schema。

## 非目标

- 本阶段不改后端存储结构。
- 本阶段不改变 SSE 合并逻辑。
- 本阶段不重新设计详情页整体布局。
- 本阶段不增加新的协议类型，只为后续扩展预留结构。
