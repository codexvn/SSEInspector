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
  store.loadPage(1)
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
        <span>OpenAI {{ openaiCount }} <span class="stat-hint">(本页)</span></span>
        <span>Anthropic {{ anthropicCount }} <span class="stat-hint">(本页)</span></span>
        <span class="stat-streaming">进行中 {{ streamingCount }} <span class="stat-hint">(本页)</span></span>
        <span>错误 {{ errorCount }} <span class="stat-hint">(本页)</span></span>
      </div>
      <div class="top-actions">
        <input v-model="searchQuery" placeholder="搜索路径、模型、请求、响应…" class="search-input" />
        <button class="btn-clear" @click="handleClear">清空</button>
      </div>
    </div>

    <!-- 表格 -->
    <div class="list-view">
      <table v-if="filtered.length > 0">
        <thead>
          <tr>
            <th>时间</th>
            <th>API</th>
            <th>模型</th>
            <th>状态</th>
            <th>预览</th>
            <th>耗时</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in filtered" :key="r.id" @click="openDetail(r.id)">
            <td class="cell-time">{{ fmtTime(r.timestamp) }}</td>
            <td class="cell-api">
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
              <em v-if="r.state === 'streaming'" style="color:var(--accent);margin-right:4px;">流式传输中…</em>
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
    </div>

    <Pagination />
  </div>
</template>

<style scoped>
.list-page { max-width: 1280px; margin: 0 auto; padding: 28px 24px; }

.top-bar {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 24px; padding: 20px 24px; flex-wrap: wrap; gap: 12px;
  background: var(--bg-card); border-radius: var(--radius); box-shadow: var(--shadow);
}
.stats { display: flex; gap: 20px; font-size: 0.82rem; color: var(--text-secondary); font-weight: 500; }
.stats span { white-space: nowrap; }
.stat-streaming { color: var(--accent); }
.stat-hint { color: var(--text-muted); font-size: 0.7rem; }
.top-actions { display: flex; gap: 8px; align-items: center; margin-left: auto; }
.search-input {
  padding: 8px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  font-size: 0.84rem; font-family: var(--font-sans); width: 240px; outline: none;
  transition: border-color .15s; background: var(--bg); color: var(--text-primary);
}
.search-input:focus { border-color: var(--accent); }
.search-input::placeholder { color: var(--text-muted); }

.btn-clear {
  margin-left: 10px; background: var(--error); color: #fff; border: none;
  padding: 8px 18px; border-radius: var(--radius-sm); cursor: pointer;
  font-size: 0.82rem; font-weight: 600; transition: opacity .15s;
}
.btn-clear:hover { opacity: .85; }

.list-view {
  background: var(--bg-card); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden;
}

table { width: 100%; border-collapse: collapse; }
thead { background: var(--bg-inset); border-bottom: 1px solid var(--border); }
th {
  text-align: left; padding: 11px 16px; font-size: 0.73rem;
  font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--text-secondary);
}
td { padding: 12px 16px; font-size: 0.84rem; border-bottom: 1px solid var(--border); }
tbody tr { cursor: pointer; transition: background .12s; }
tbody tr:hover { background: #f5f6ff; }
tbody tr:last-child td { border-bottom: none; }

.cell-time { white-space: nowrap; color: var(--text-secondary); font-family: var(--font-mono); font-size: 0.78rem; }
.cell-model { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.cell-api { white-space: nowrap; font-size: 0.75rem; }
.cell-preview { max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
.cell-duration { white-space: nowrap; color: var(--text-secondary); font-family: var(--font-mono); font-size: 0.78rem; }

.empty-state { text-align: center; padding: 64px 20px; color: var(--text-muted); font-size: 0.95rem; }

@media (max-width: 768px) {
  .top-bar { flex-wrap: wrap; gap: 12px; }
  .cell-preview { max-width: 120px; }
  .cell-model { max-width: 80px; }
}
</style>
