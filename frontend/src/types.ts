export type ApiProvider = 'openai' | 'anthropic'
export type ApiEndpoint = 'openai-chat' | 'openai-responses' | 'anthropic-messages'
export type RequestListFilter = 'all' | 'openai' | 'anthropic' | 'streaming' | 'error'

/** 后端 RecordSummary 的前端映射 */
export interface RecordSummary {
  id: string
  timestamp: string
  model: string
  status: number
  preview: string
  streaming: boolean
  durationMs: number
  state: 'streaming' | 'done' | 'error'
  apiType: 'openai' | 'anthropic'
  /** 请求路径，供按 /chat/completions、/responses、/messages 判定响应格式 */
  path?: string
  streamText?: string
  cacheRead?: number
  apiReportedInput?: number
  sessionId?: string
  sessionIdKey?: string
  /** API 报告输出 token 数（completion_tokens / output_tokens） */
  outputTokens?: number
}

export interface RecordedRequest {
  id: string
  timestamp: string
  method: string
  path: string
  upstreamUrl: string
  requestHeaders: Record<string, string>
  responseHeaders?: Record<string, string>
  requestBody: unknown
  responseStatus: number
  responseContent: unknown
  streaming: boolean
  durationMs: number
  apiType: 'openai' | 'anthropic'
  error?: string
  state: 'streaming' | 'done' | 'error'
  finished?: string
  streamText?: string
  responseBody?: string
  tokenBreakdown?: TokenBreakdown
  /** API 报告输出 token 数（completion_tokens / output_tokens） */
  outputTokens?: number
  sessionId?: string
  sessionIdKey?: string
}

export interface TokenBreakdown {
  messages: number
  tools: number
  systemPrompt: number
  cacheRead: number
  totalInput: number
  apiReportedInput: number
  tokenizerSource?: string
}

export interface ToolCallEntry {
  tool_call_id: string
  tool_name: string
  arguments?: string
  result?: string
}

export interface ListResult {
  items: RecordSummary[]
  total: number
  page: number
  pageSize: number
  counts?: { openai: number; anthropic: number; streaming: number; error: number }
}

export interface StatsResult {
  total: number
  openai: number
  anthropic: number
  streaming: number
  error: number
}

export interface GlobalNeighbors {
  prevId: string | null
  nextId: string | null
  index: number
  total: number
}

/** 后端 tokenize 接口返回：token 数与所用 tokenizer 来源 */
export interface TokenizeResult {
  count: number
  source: string | null
}

export interface SSEEvent {
  type: 'update'
  record?: RecordSummary
}
