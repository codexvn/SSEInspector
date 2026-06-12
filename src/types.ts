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
  reasoning_content?: string;
  tool_calls?: MergedToolCall[];
}

interface MergedChoice {
  index: number;
  message: MergedMessage;
  finish_reason: string | null;
}

interface MergedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface MergedResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: MergedChoice[];
  usage?: MergedUsage;
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
}

// ---- Anthropic types ----

export interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'thinking';
  index: number;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface AnthropicMergedResponse {
  id: string;
  model: string;
  role: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    service_tier?: string;
  };
}

// ---- Token breakdown ----

export interface OpenAIResponsesUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  service_tier?: string;
}

export interface TokenBreakdown {
  messages: number;           // 消息内容（不含 system）
  tools: number;              // 工具定义
  systemPrompt: number;       // 系统提示
  cacheRead: number;          // 缓存命中（来自 usage.cache_read_input_tokens）
  totalInput: number;         // messages + tools + systemPrompt（我们算的）
  apiReportedInput: number;   // API 报告输入（Chat: prompt_tokens, Responses: input_tokens + cache_read, Anthropic: input_tokens + cache_read）
  tokenizerSource?: string;   // 使用的 tokenizer（如 "gpt-tokenizer"、"@anthropic-ai/tokenizer"、"hf-download"）
}

// ---- Shared ----

export type ApiType = 'openai' | 'anthropic';
export type MergedContent = MergedResponse | OpenAIResponsesMergedResponse | AnthropicMergedResponse;
type RecordState = 'streaming' | 'done' | 'error';

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
  chunks: SSEChunk[];
  streamText?: string;
  responseBody?: string;
  tokenBreakdown?: TokenBreakdown;
}

export interface RecordSummary {
  id: string;
  timestamp: string;
  model: string;
  status: number;
  preview: string;
  searchText?: string;
  streaming: boolean;
  durationMs: number;
  state: RecordState;
  apiType: ApiType;
  streamText?: string;
}
