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

export interface MergedMessage {
  role: string;
  content: string;
  reasoning_content?: string;
  tool_calls?: MergedToolCall[];
}

export interface MergedChoice {
  index: number;
  message: MergedMessage;
  finish_reason: string | null;
}

export interface MergedUsage {
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
  };
}

// ---- Shared ----

export type ApiType = 'openai' | 'anthropic';
export type MergedContent = MergedResponse | AnthropicMergedResponse;
export type RecordState = 'streaming' | 'done' | 'error';

export interface SSEChunk {
  event?: string;
  data: unknown;
}

export interface RecordedRequest {
  id: string;
  timestamp: string;
  method: string;
  path: string;
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
  streamText?: string;
}
