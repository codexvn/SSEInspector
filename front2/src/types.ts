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
  streamText?: string
  cacheRead?: number
  apiReportedInput?: number
  sessionId?: string
  sessionIdKey?: string
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

export interface SSEEvent {
  type: 'update' | 'clear'
  record?: RecordSummary
}
