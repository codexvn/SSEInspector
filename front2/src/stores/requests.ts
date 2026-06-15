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

  function startSSE() {
    if (sseCleanup) sseCleanup()
    sseCleanup = connectSSE(
      (summary) => {
        const idx = items.value.findIndex(r => r.id === summary.id)
        if (idx >= 0) {
          items.value.splice(idx, 1, summary)
        } else {
          total.value++
          if (page.value === 1) {
            items.value.unshift(summary)
            if (items.value.length > pageSize) items.value.pop()
          }
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
    if (detailCache.value.has(id)) return detailCache.value.get(id)
    try {
      const record = await fetchDetail(id)
      detailCache.value.set(id, record)
      return record
    } catch {
      return undefined
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
  }
})
