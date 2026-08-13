export const ApiType = {
  OpenAI: 'openai',
  Anthropic: 'anthropic',
  Passthrough: 'passthrough',
} as const
export type ApiType = (typeof ApiType)[keyof typeof ApiType]
/** 兼容旧名 */
export type ApiProvider = ApiType

export const ApiEndpoint = {
  OpenAIChat: 'openai-chat',
  OpenAIResponses: 'openai-responses',
  AnthropicMessages: 'anthropic-messages',
  Passthrough: 'passthrough',
} as const
export type ApiEndpoint = (typeof ApiEndpoint)[keyof typeof ApiEndpoint]

export const RequestListFilter = {
  All: 'all',
  OpenAI: 'openai',
  Anthropic: 'anthropic',
  Passthrough: 'passthrough',
  Streaming: 'streaming',
  Error: 'error',
} as const
export type RequestListFilter = (typeof RequestListFilter)[keyof typeof RequestListFilter]

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
  apiType: ApiType
  apiEndpoint: ApiEndpoint
  /** 请求路径仅用于展示。 */
  path: string
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
  apiType: ApiType
  apiEndpoint: ApiEndpoint
  error?: string
  state: 'streaming' | 'done' | 'error'
  finished?: string
  streamText?: string
  responseBody?: string
  /** API 报告输出 token 数（completion_tokens / output_tokens） */
  outputTokens?: number
  sessionId?: string
  sessionIdKey?: string
}

export interface ToolCallEntry {
  tool_call_id: string
  tool_name: string
  arguments?: string
  result?: string
}

export interface ListCounts {
  openai: number
  anthropic: number
  passthrough: number
  streaming: number
  error: number
}

export interface ListResult {
  items: RecordSummary[]
  total: number
  page: number
  pageSize: number
  counts?: ListCounts
}

export interface StatsResult {
  total: number
  openai: number
  anthropic: number
  passthrough: number
  streaming: number
  error: number
}

export interface GlobalNeighbors {
  prevId: string | null
  nextId: string | null
  index: number
  total: number
}

export interface SSEEvent {
  type: 'update'
  record?: RecordSummary
}
