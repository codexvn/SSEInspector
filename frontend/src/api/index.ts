import type { ApiEndpoint, ApiType, RecordSummary, RecordedRequest, ListResult, StatsResult, GlobalNeighbors, ToolCallEntry, SSEEvent, RequestListFilter, RoutingState, RoutingSavePayload, UpstreamRoute, RetentionConfig, RetentionStatus, RetentionRunResult } from '../types'
import { formatErrorChain } from '../error'

const BASE = '/api'

export async function fetchList(page: number, pageSize: number, filter: RequestListFilter, sessionId?: string): Promise<ListResult> {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    filter,
  })
  if (sessionId) params.set('sessionId', sessionId)
  const res = await fetch(`${BASE}/requests?${params.toString()}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json() as Partial<ListResult>
  if (!Array.isArray(data.items)
    || typeof data.total !== 'number'
    || typeof data.page !== 'number'
    || typeof data.pageSize !== 'number') {
    throw new Error('请求列表响应结构非法')
  }
  data.items.forEach((item, index) => assertApiRecord(item, `列表第 ${index + 1} 条记录`))
  return data as ListResult
}

export async function fetchDetail(id: string): Promise<RecordedRequest> {
  const res = await fetch(`${BASE}/requests/${id}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return parseRecordedRequest(await res.json(), '请求详情')
}

/** 查询同一会话中指定请求的上一条已完成请求 */
export async function fetchPrev(id: string): Promise<RecordedRequest | null> {
  const res = await fetch(`${BASE}/requests/${id}/prev`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return parseNullableRecordedRequest(await res.json(), '上一条请求')
}

/** 查询同一会话中指定请求的下一条请求 */
export async function fetchNext(id: string): Promise<RecordedRequest | null> {
  const res = await fetch(`${BASE}/requests/${id}/next`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return parseNullableRecordedRequest(await res.json(), '下一条请求')
}

export async function fetchStats(): Promise<StatsResult> {
  const res = await fetch(`${BASE}/stats`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function fetchNeighbors(id: string): Promise<GlobalNeighbors> {
  const res = await fetch(`${BASE}/requests/${id}/neighbors`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
export async function fetchToolCalls(requestId: string): Promise<{ toolCalls: ToolCallEntry[] }> {
  const res = await fetch(`${BASE}/tool-calls?requestId=${requestId}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function fetchToolCallPair(
  toolName: string, toolCallId: string,
): Promise<{ prevResult?: string; nextRequest?: string }> {
  const res = await fetch(
    `${BASE}/tool-calls?toolName=${encodeURIComponent(toolName)}&toolCallId=${encodeURIComponent(toolCallId)}`,
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** 读取多上游分流配置 */
export async function fetchRouting(): Promise<RoutingState> {
  const res = await fetch(`${BASE}/routing`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return parseRoutingState(await res.json(), '路由配置')
}

/** 保存多上游分流配置（整文档替换，保存后即时生效） */
export async function saveRouting(payload: RoutingSavePayload): Promise<RoutingState> {
  const res = await fetch(`${BASE}/routing`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    // 400 携带后端校验的中文错误清单，直接透出给设置页展示
    const detail = await res.json().catch(() => null) as { error?: string; details?: string[] } | null
    const reasons = detail?.details?.length ? `：${detail.details.join('；')}` : ''
    throw new Error(`${detail?.error ?? `HTTP ${res.status}`}${reasons}`)
  }
  return parseRoutingState(await res.json(), '路由配置')
}

function parseRoutingState(value: unknown, label: string): RoutingState {
  if (typeof value !== 'object' || value === null) throw new Error(`${label} 不是对象`)
  const state = value as Partial<RoutingState>
  if (!Array.isArray(state.routes)) throw new Error(`${label} 缺少 routes 数组`)
  state.routes.forEach((route, index) => assertRoutingRoute(route, `路由规则第 ${index + 1} 条`))
  return state as RoutingState
}

export async function fetchRetention(): Promise<RetentionStatus> {
  const res = await fetch(`${BASE}/retention`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (typeof data !== 'object' || data === null
    || typeof data.total !== 'number'
    || !Array.isArray(data.archives)
    || typeof data.config?.enabled !== 'boolean') {
    throw new Error('轮转状态响应结构非法')
  }
  return data as RetentionStatus
}

/** 保存轮转配置（400 时透出后端校验的中文错误清单） */
export async function saveRetention(config: RetentionConfig): Promise<RetentionConfig> {
  const res = await fetch(`${BASE}/retention`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => null) as { error?: string; details?: string[] } | null
    const reasons = detail?.details?.length ? `：${detail.details.join('；')}` : ''
    throw new Error(`${detail?.error ?? `HTTP ${res.status}`}${reasons}`)
  }
  return res.json()
}

/** 手动立即执行一次轮转 */
export async function runRetention(): Promise<RetentionRunResult> {
  const res = await fetch(`${BASE}/retention/run`, { method: 'POST' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** 归档文件的下载地址（浏览器原生下载） */
export function retentionArchiveUrl(name: string): string {
  return `${BASE}/retention/archives/${encodeURIComponent(name)}`
}

function assertRoutingRoute(value: { id?: unknown; name?: unknown; enabled?: unknown; prefix?: unknown; upstream?: unknown }, label: string): asserts value is UpstreamRoute {
  if (typeof value.id !== 'string' || typeof value.name !== 'string'
    || typeof value.enabled !== 'boolean' || typeof value.prefix !== 'string' || typeof value.upstream !== 'string') {
    throw new Error(`${label} 结构非法`)
  }
}

/** 连接 SSE 实时推送，返回取消函数；onReconnect 在断线后重连成功时触发（首次连接不算） */
export function connectSSE(
  onUpdate: (r: RecordSummary) => void,
  handlers?: { onReconnect?: () => void },
): () => void {
  const es = new EventSource(`${BASE}/events`)
  let everConnected = false

  es.addEventListener('open', () => {
    if (everConnected) handlers?.onReconnect?.()
    everConnected = true
  })
  es.addEventListener('message', (e) => {
    try {
      const msg: SSEEvent = JSON.parse(e.data)
      if (msg.type === 'update' && msg.record) {
        assertApiRecord(msg.record, 'SSE 更新记录')
        onUpdate(msg.record)
      }
    } catch (err) {
      console.warn(`[api] SSE 消息解析失败: ${formatErrorChain(err)}`)
    }
  })

  return () => es.close()
}

const ENDPOINT_PROVIDERS: Readonly<Record<ApiEndpoint, ApiType>> = {
  'openai-chat': 'openai',
  'openai-responses': 'openai',
  'anthropic-messages': 'anthropic',
  passthrough: 'passthrough',
}
const API_ENDPOINTS = new Set<ApiEndpoint>(Object.keys(ENDPOINT_PROVIDERS) as ApiEndpoint[])

export function assertApiRecord(
  value: { apiEndpoint?: unknown; apiType?: unknown; path?: unknown },
  label: string,
): asserts value is { apiEndpoint: ApiEndpoint; apiType: ApiType; path: string } {
  if (typeof value.apiEndpoint !== 'string' || !API_ENDPOINTS.has(value.apiEndpoint as ApiEndpoint)) {
    throw new Error(`${label} 缺少合法 apiEndpoint: ${String(value.apiEndpoint)}`)
  }
  const endpoint = value.apiEndpoint as ApiEndpoint
  if (value.apiType !== ENDPOINT_PROVIDERS[endpoint]) {
    throw new Error(`${label} 的 apiType 与 apiEndpoint 不一致: ${String(value.apiType)} / ${endpoint}`)
  }
  if (typeof value.path !== 'string' || value.path.length === 0) {
    throw new Error(`${label} 缺少合法 path`)
  }
}

function parseRecordedRequest(value: unknown, label: string): RecordedRequest {
  if (typeof value !== 'object' || value === null) throw new Error(`${label} 不是对象`)
  assertApiRecord(value, label)
  return value as RecordedRequest
}

function parseNullableRecordedRequest(value: unknown, label: string): RecordedRequest | null {
  return value === null ? null : parseRecordedRequest(value, label)
}

