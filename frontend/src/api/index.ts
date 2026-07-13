import type { ApiEndpoint, RecordSummary, RecordedRequest, ListResult, StatsResult, GlobalNeighbors, TokenizeResult, ToolCallEntry, SSEEvent, RequestListFilter } from '../types'

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
/** 调用后端 tokenizer 计算 token 数（复用后端模型路由） */
export async function fetchTokenize(text: string, model: string): Promise<TokenizeResult> {
  const res = await fetch(`${BASE}/tokenize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model }),
  })
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

/** 连接 SSE 实时推送，返回取消函数 */
export function connectSSE(onUpdate: (r: RecordSummary) => void): () => void {
  const es = new EventSource(`${BASE}/events`)

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

const ENDPOINT_PROVIDERS: Readonly<Record<ApiEndpoint, 'openai' | 'anthropic'>> = {
  'openai-chat': 'openai',
  'openai-responses': 'openai',
  'anthropic-messages': 'anthropic',
}
const API_ENDPOINTS = new Set<ApiEndpoint>(Object.keys(ENDPOINT_PROVIDERS) as ApiEndpoint[])

export function assertApiRecord(
  value: { apiEndpoint?: unknown; apiType?: unknown; path?: unknown },
  label: string,
): asserts value is { apiEndpoint: ApiEndpoint; apiType: 'openai' | 'anthropic'; path: string } {
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

function formatErrorChain(error: unknown): string {
  const messages: string[] = []
  let current: unknown = error
  while (current) {
    if (current instanceof Error) {
      messages.push(`${current.name}: ${current.message}`)
      current = current.cause
      continue
    }
    messages.push(String(current))
    break
  }
  return messages.join(' -> ')
}
