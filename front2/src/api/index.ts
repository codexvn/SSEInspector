import type { RecordSummary, RecordedRequest, ListResult, ToolCallEntry, SSEEvent } from '../types'

const BASE = '/api'

export async function fetchList(page: number, pageSize: number): Promise<ListResult> {
  const res = await fetch(`${BASE}/requests?page=${page}&pageSize=${pageSize}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function fetchDetail(id: string): Promise<RecordedRequest> {
  const res = await fetch(`${BASE}/requests/${id}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function clearAll(): Promise<void> {
  await fetch(`${BASE}/requests`, { method: 'DELETE' })
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
export function connectSSE(onUpdate: (r: RecordSummary) => void, onClear: () => void): () => void {
  const es = new EventSource(`${BASE}/events`)

  es.addEventListener('message', (e) => {
    try {
      const msg: SSEEvent = JSON.parse(e.data)
      if (msg.type === 'update' && msg.record) onUpdate(msg.record)
      else if (msg.type === 'clear') onClear()
    } catch { /* ignore malformed */ }
  })

  return () => es.close()
}
