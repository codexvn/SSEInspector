import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { RecordSummary, RecordedRequest } from '../types'
import { fetchList, fetchDetail, clearAll, connectSSE } from '../api'

export const useRequestsStore = defineStore('requests', () => {
  // ---- 列表状态 ----
  const items = ref<RecordSummary[]>([])
  const page = ref(1)
  const pageSize = 50
  const total = ref(0)
  const loading = ref(false)

  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))

  // ---- SSE ----
  let sseCleanup: (() => void) | null = null
  /** 外部注册的 streaming→done 回调，供 DetailView 绑定刷新 */
  const onStreamDone = ref<((id: string) => void) | null>(null)

  function startSSE() {
    if (sseCleanup) sseCleanup()
    sseCleanup = connectSSE(
      (summary) => {
        const idx = items.value.findIndex(r => r.id === summary.id)
        const wasStreaming = idx >= 0 && items.value[idx].state === 'streaming'
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
        // streaming → done 转换：通知详情页刷新
        if (wasStreaming && summary.state === 'done') {
          onStreamDone.value?.(summary.id)
        }
      },
      () => {
        items.value = []
        total.value = 0
      },
    )
  }

  // ---- 操作 ----
  async function loadPage(p: number) {
    loading.value = true
    try {
      const data = await fetchList(p, pageSize)
      items.value = data.items
      total.value = data.total
      page.value = data.page
    } finally {
      loading.value = false
    }
  }

  async function doClear() {
    await clearAll()
    items.value = []
    total.value = 0
    page.value = 1
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
    } catch {
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
    items, page, pageSize, total, loading, totalPages,
    loadPage, doClear,
    detailCache, loadDetail, updateDetailInCache,
    onStreamDone,
  }
})
