// ---- OpenAI types ----

export interface MergedToolCall {
  index: number;
  id?: string;
  type?: string;
  function: {
    name?: string;
    arguments: string;
  };
}

interface MergedMessage {
  role: string;
  content: string;
  refusal?: string;
  reasoning_content?: string;
  function_call?: { name?: string; arguments: string };
  tool_calls?: MergedToolCall[];
  logprobs?: unknown;
  filter_results?: unknown;
  [key: string]: unknown;
}

interface MergedChoice {
  index: number;
  message: MergedMessage;
  finish_reason: string | null;
  logprobs?: unknown;
  content_filter_results?: unknown;
  [key: string]: unknown;
}

/**
 * /chat/completions 响应中的 usage 字段（OpenAI 标准格式）。
 * 字段均为可选：非标供应商（如 DeepSeek）使用不同字段名（input_tokens 等），
 * 运行时通过模型名检测分支处理，此处不混入非标字段。
 */
interface MergedUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_miss_tokens?: number;
  };
  [key: string]: unknown;
}

export interface MergedResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: MergedChoice[];
  usage?: MergedUsage;
  [key: string]: unknown;
}

export interface OpenAIResponsesMergedResponse {
  id: string;
  object: string;
  created?: number;
  created_at?: number;
  model: string;
  status?: string;
  output_text?: string;
  reasoning_text?: string;
  output?: unknown[];
  tool_calls?: MergedToolCall[];
  usage?: OpenAIResponsesUsage;
  error?: Record<string, unknown> | null;
  incomplete_details?: Record<string, unknown> | null;
  [key: string]: unknown;
}

// ---- Anthropic types ----

export interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'thinking' | 'redacted_thinking' | string;
  index: number;
  text?: string;
  thinking?: string;
  citations?: unknown[];
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  data?: unknown;
  [key: string]: unknown;
}

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  service_tier?: string;
  [key: string]: unknown;
}

export interface AnthropicMergedResponse {
  id: string;
  model: string;
  role: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage?: AnthropicUsage;
}

// ---- Token breakdown ----

export interface OpenAIResponsesUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
  service_tier?: string;
  [key: string]: unknown;
}

export interface TokenBreakdown {
  messages: number;           // 消息内容（不含 system）
  tools: number;              // 工具定义
  systemPrompt: number;       // 系统提示
  cacheRead: number;          // 缓存命中（OpenAI: input_tokens_details.cached_tokens；Anthropic: cache_read_input_tokens）
  totalInput: number;         // messages + tools + systemPrompt（我们算的）
  apiReportedInput: number;   // API 报告输入（OpenAI: prompt_tokens/input_tokens；Anthropic: input_tokens + cache_read）
  tokenizerSource?: string;   // 使用的 tokenizer（如 "gpt-tokenizer"、"@anthropic-ai/tokenizer"、"hf-download"）
}

// ---- Shared ----

export type ApiType = 'openai' | 'anthropic';
export type ApiEndpoint = 'openai-chat' | 'openai-responses' | 'anthropic-messages';
export type MergedContent = MergedResponse | OpenAIResponsesMergedResponse | AnthropicMergedResponse;
export type RecordState = 'streaming' | 'done' | 'error';
export type RequestListFilter = 'all' | 'openai' | 'anthropic' | 'streaming' | 'error';

export interface SSEChunk {
  event?: string;
  data: unknown;
}

export interface RecordedRequest {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  upstreamUrl: string;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody: unknown;
  responseStatus: number;
  responseContent: MergedContent | null;
  streaming: boolean;
  durationMs: number;
  apiType: ApiType;
  error?: string;
  state: RecordState;
  /** 'pending'|'ok'|'client_close'|'startup_fallback'，store 写入 */
  finished?: string;
  streamText?: string;
  responseBody?: string;
  /** Tokenizer 计算的输入分解（JSON TEXT 列 computed_tokens） */
  tokenBreakdown?: TokenBreakdown;
  /** 接口原始 usage 对象（JSON TEXT 列 api_usage），字段因供应商而异 */
  apiUsage?: string;
  /** API 报告输出 token 数（从 apiUsage 解析：completion_tokens / output_tokens） */
  outputTokens?: number;
  /** 会话标识（从已知请求头提取） */
  sessionId?: string;
  /** 会话标识来源头名称 */
  sessionIdKey?: string;
}

export interface RecordSummary {
  id: string;
  timestamp: string;
  model: string;
  status: number;
  preview: string;
  streaming: boolean;
  durationMs: number;
  state: RecordState;
  apiType: ApiType;
  /** 请求路径，供前端按 /chat/completions、/responses、/messages 判定响应格式 */
  path?: string;
  streamText?: string;
  /** 缓存命中 token 数（来自 apiUsage 解析） */
  cacheRead?: number;
  /** API 报告输入 token 数（来自 apiUsage 解析） */
  apiReportedInput?: number;
  /** API 报告输出 token 数（来自 apiUsage 解析：completion_tokens / output_tokens） */
  outputTokens?: number;
  /** 会话标识（从已知请求头提取） */
  sessionId?: string;
  /** 会话标识来源头名称 */
  sessionIdKey?: string;
}
