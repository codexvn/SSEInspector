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
  method: string
  model: string
  status: number
  preview: string
  streaming: boolean
  durationMs: number
  /** pending = 请求已发出、上游尚未响应；streaming = 响应进行中 */
  state: 'pending' | 'streaming' | 'done' | 'error'
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
  /** 响应文本字符数：usage 输出 token 缺失时的速度兜底指标 */
  responseChars?: number
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
  state: 'pending' | 'streaming' | 'done' | 'error'
  finished?: string
  streamText?: string
  responseBody?: string
  /** API 报告输出 token 数（completion_tokens / output_tokens） */
  outputTokens?: number
  /** 响应文本字符数：usage 输出 token 缺失时的速度兜底指标 */
  responseChars?: number
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

/** 分流规则：路径前缀 → 上游，数组顺序即优先级 */
export interface UpstreamRoute {
  id: string
  name: string
  enabled: boolean
  prefix: string
  upstream: string
}

/** 设置页读回的路由状态：CLI 默认上游、界面持久值与生效值 */
export interface RoutingState {
  cliUpstream: string | null
  persistedDefault: string | null
  effectiveDefault: string | null
  routes: UpstreamRoute[]
}

/** 保存请求体：整文档替换 */
export interface RoutingSavePayload {
  defaultUpstream: string | null
  routes: UpstreamRoute[]
}

/** 数据轮转配置：启用后按数据量轮转（总数超过触发阈值时删最老至保留量） */
export interface RetentionConfig {
  enabled: boolean
  triggerCount: number
  keepCount: number
}

/** 轮转归档文件条目 */
export interface RetentionArchiveEntry {
  name: string
  size: number
  modifiedAt: string
}

/** GET /api/retention 响应：配置 + 当前总数 + 归档列表 */
export interface RetentionStatus {
  config: RetentionConfig
  total: number
  archives: RetentionArchiveEntry[]
}

/** 手动或定时轮转的执行结果 */
export interface RetentionRunResult {
  rotated: boolean
  enabled?: boolean
  deleted?: number
  archivedFile?: string
  total: number
}
