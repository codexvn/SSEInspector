<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useRequestsStore } from '../stores/requests'
import Pagination from '../components/Pagination.vue'

const store = useRequestsStore()
const router = useRouter()
const searchQuery = ref('')

const filtered = computed(() => {
  const q = searchQuery.value.toLowerCase().trim()
  if (!q) return store.items
  return store.items.filter(r => {
    const hay = [r.id, r.model, r.preview, r.apiType, String(r.status), r.state].join('\n').toLowerCase()
    return hay.includes(q)
  })
})

const openaiCount = computed(() => store.items.filter(r => r.apiType === 'openai').length)
const anthropicCount = computed(() => store.items.filter(r => r.apiType === 'anthropic').length)
const streamingCount = computed(() => store.items.filter(r => r.state === 'streaming').length)
const errorCount = computed(() => store.items.filter(r => r.state === 'error').length)

onMounted(() => {
  if (store.items.length === 0) store.loadPage(1)
})

function openDetail(id: string) {
  router.push({ name: 'detail', params: { id } })
}

async function handleClear() {
  if (!confirm('确认清空全部记录？')) return
  await store.doClear()
}

function fmtTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}
</script>

<template>
  <div class="list-page">
    <!-- 顶栏 -->
    <div class="top-bar">
      <div class="stats">
        <span>总计 {{ store.total }}</span>
        <span class="stat-openai">OpenAI {{ openaiCount }}</span>
        <span class="stat-anthropic">Anthropic {{ anthropicCount }}</span>
        <span class="stat-streaming">进行中 {{ streamingCount }}</span>
        <span class="stat-error">错误 {{ errorCount }}</span>
      </div>
      <div class="top-actions">
        <input v-model="searchQuery" placeholder="搜索…" class="search-input" />
        <button @click="handleClear" class="btn-clear">清空</button>
      </div>
    </div>

    <!-- 表格 -->
    <table v-if="filtered.length > 0">
      <thead>
        <tr>
          <th style="width:90px">时间</th>
          <th style="width:70px">API</th>
          <th style="width:130px">模型</th>
          <th style="width:60px">状态</th>
          <th>预览</th>
          <th style="width:60px">耗时</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in filtered" :key="r.id" @click="openDetail(r.id)" class="req-row">
          <td class="cell-time">{{ fmtTime(r.timestamp) }}</td>
          <td>
            <span v-if="r.apiType === 'anthropic'" class="badge badge-anthropic">Anthropic</span>
            <span v-else class="badge badge-openai">OpenAI</span>
          </td>
          <td class="cell-model" :title="r.model">{{ r.model }}</td>
          <td>
            <span v-if="r.state === 'streaming'" class="badge badge-streaming">传输中</span>
            <span v-else-if="r.status < 300" class="badge badge-ok">{{ r.status }}</span>
            <span v-else-if="r.status < 500" class="badge badge-warn">{{ r.status }}</span>
            <span v-else class="badge badge-err">{{ r.status }}</span>
          </td>
          <td class="cell-preview">
            <em v-if="r.state === 'streaming'" class="streaming-hint">流式传输中…</em>
            <span v-else>{{ r.preview }}</span>
          </td>
          <td class="cell-duration">
            <template v-if="r.state === 'streaming'">…</template>
            <template v-else>{{ r.durationMs }}ms</template>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-else class="empty-state">
      {{ searchQuery ? '无匹配请求' : '暂无记录，发送请求到代理即可看到' }}
    </div>

    <Pagination />
  </div>
</template>

<style scoped>
.list-page { max-width: 1200px; margin: 0 auto; padding: 16px; }

.top-bar {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 12px; flex-wrap: wrap; gap: 8px;
}
.stats { display: flex; gap: 16px; font-size: 0.85rem; color: var(--text-secondary); }
.stat-streaming { color: var(--accent); font-weight: 600; }
.stat-error { color: var(--error); }
.top-actions { display: flex; gap: 8px; align-items: center; }
.search-input {
  padding: 5px 10px; border: 1px solid #d0d5dd; border-radius: 6px;
  font-size: 0.85rem; width: 180px; outline: none;
}
.search-input:focus { border-color: var(--accent); }
.btn-clear { background: #fee2e2; color: var(--error); }

tr.req-row { cursor: pointer; transition: background 0.1s; }
tr.req-row:hover { background: #f0f5ff; }
.cell-time { font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 0.8rem; color: var(--text-secondary); }
.cell-model { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cell-preview { max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cell-duration { font-variant-numeric: tabular-nums; font-size: 0.8rem; color: var(--text-secondary); }
.streaming-hint { color: var(--accent); margin-right: 4px; }
.empty-state { text-align: center; padding: 60px 0; color: var(--text-secondary); }
</style>
