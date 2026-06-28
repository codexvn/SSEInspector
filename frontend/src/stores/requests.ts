import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { RecordSummary, RecordedRequest, RequestListFilter } from '../types'
import { fetchList, fetchDetail, connectSSE, fetchStats } from '../api'

export const useRequestsStore = defineStore('requests', () => {
  // ---- 列表状态 ----
  const items = ref<RecordSummary[]>([])
  const page = ref(1)
  const pageSize = 50
  const total = ref(0)
  const loading = ref(false)
  const counts = ref({ total: 0, openai: 0, anthropic: 0, streaming: 0, error: 0 })
  const activeFilter = ref<RequestListFilter>('all')
  /** 会话维度过滤，与类别 filter 正交；非空时只显示该会话的请求 */
  const sessionFilter = ref<string | null>(null)

  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))

  function matchesActiveFilter(record: RecordSummary): boolean {
    // 类别维度
    switch (activeFilter.value) {
      case 'openai':
        if (record.apiType !== 'openai') return false
        break
      case 'anthropic':
        if (record.apiType !== 'anthropic') return false
        break
      case 'streaming':
        if (record.state !== 'streaming') return false
        break
      case 'error':
        if (record.state !== 'error') return false
        break
      case 'all':
      default:
        break
    }
    // 会话维度：与类别 filter 取交集
    if (sessionFilter.value && record.sessionId !== sessionFilter.value) return false
    return true
  }

  // ---- SSE ----
  let sseCleanup: (() => void) | null = null
  /** 外部注册的 streaming→done 回调，供 DetailView 绑定刷新。
   *  使用 ref 以便 Pinia 正确代理 store 上的赋值。 */
  const onStreamDone = ref<((id: string) => void) | null>(null)
  /** 外部注册的“列表有更新”回调：每次 SSE 推送后触发，
   *  供 ListView 重查统计、DetailView 重查全局/会话导航。 */
  const onListUpdate = ref<(() => void) | null>(null)

  function startSSE() {
    if (sseCleanup) sseCleanup()
    sseCleanup = connectSSE((summary) => {
      const idx = items.value.findIndex(r => r.id === summary.id)
      const wasStreaming = idx >= 0 && items.value[idx].state === 'streaming'
      const matchesFilter = matchesActiveFilter(summary)
      if (!matchesFilter) {
        if (idx >= 0) {
          items.value.splice(idx, 1)
          total.value = Math.max(0, total.value - 1)
        }
        onListUpdate.value?.()
        if (wasStreaming && summary.state === 'done') {
          onStreamDone.value?.(summary.id)
        }
        return
      }
      if (idx >= 0) {
        items.value.splice(idx, 1, summary)
      } else {
        total.value++
        if (page.value === 1) {
          items.value.unshift(summary)
          if (items.value.length > pageSize) items.value.pop()
        }
      }
      // 按时间降序排序
      items.value.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      // 统计改由接口实时查询，此处不再增量维护 counts
      onListUpdate.value?.()
      // streaming → done 转换：通知详情页刷新
      if (wasStreaming && summary.state === 'done') {
        onStreamDone.value?.(summary.id)
      }
    })
  }

  // ---- 操作 ----
  async function loadPage(p: number) {
    loading.value = true
    try {
      const data = await fetchList(p, pageSize, activeFilter.value, sessionFilter.value ?? undefined)
      items.value = data.items
      total.value = data.total
      page.value = data.page
      // 统一通过 /api/stats 实时查询统计，避免增量维护偏差
      await loadStats()
    } finally {
      loading.value = false
    }
  }

  /** 实时查询统计并更新 counts（供 ListView 与 SSE 推送后刷新） */
  async function loadStats() {
    try {
      counts.value = await fetchStats()
    } catch (e) {
      console.warn(`[store] 加载统计失败: ${formatErrorChain(e)}`)
    }
  }

  async function setFilter(filter: RequestListFilter) {
    if (activeFilter.value === filter) {
      activeFilter.value = 'all'
    } else {
      activeFilter.value = filter
    }
    await loadPage(1)
  }

  /** 设置/切换会话维度过滤：传入当前会话 id 则清除（toggle），否则设为该会话 */
  async function setSessionFilter(sid: string | null) {
    if (!sid || sessionFilter.value === sid) {
      sessionFilter.value = null
    } else {
      sessionFilter.value = sid
    }
    await loadPage(1)
  }

  // ---- 详情缓存 ----
  const detailCache = ref<Map<string, RecordedRequest>>(new Map())

  async function loadDetail(id: string): Promise<RecordedRequest | undefined> {
    // 如果缓存的是 streaming 状态记录，重新 fetch（可能已完成）
    const cached = detailCache.value.get(id)
    if (cached && cached.state !== 'streaming') return cached

    try {
      const record = await fetchDetail(id)
      detailCache.value.set(id, record)
      return record
    } catch (e) {
      console.warn(`[store] 加载详情失败: ${formatErrorChain(e)}`)
      // 如果 fetch 失败但有缓存，返回缓存
      return cached ?? undefined
    }
  }

  function updateDetailInCache(id: string, patch: Partial<RecordedRequest>) {
    const existing = detailCache.value.get(id)
    if (existing) {
      detailCache.value.set(id, { ...existing, ...patch })
    }
  }

  // ---- 初始化 ----
  startSSE()

  return {
    items, page, pageSize, total, loading, totalPages, counts, activeFilter, sessionFilter,
    loadPage, loadStats, setFilter, setSessionFilter,
    detailCache, loadDetail, updateDetailInCache,
    onStreamDone, onListUpdate,
  }
})

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
