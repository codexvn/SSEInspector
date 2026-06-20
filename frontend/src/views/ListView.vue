<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useRequestsStore } from '../stores/requests'
import Pagination from '../components/Pagination.vue'
import TokenSpeed from '../components/TokenSpeed.vue'
import { detectApiEndpoint } from '../composables/useApiEndpoint'

const store = useRequestsStore()
const router = useRouter()
const searchQuery = ref('')

const filtered = computed(() => {
  const q = searchQuery.value.toLowerCase().trim()
  if (!q) return store.items
  return store.items.filter(r => {
    const hay = [r.id, r.model, r.preview, r.apiType, String(r.status), r.state, r.sessionId, r.sessionIdKey].join('\n').toLowerCase()
    return hay.includes(q)
  })
})

const openaiCount = computed(() => store.counts.openai)
const anthropicCount = computed(() => store.counts.anthropic)
const streamingCount = computed(() => store.counts.streaming)
const errorCount = computed(() => store.counts.error)

onMounted(() => {
  store.loadPage(1)
  // 列表每次 SSE 推送后重查统计，保证顶部计数实时准确
  store.onListUpdate = () => store.loadStats()
})

onUnmounted(() => {
  store.onListUpdate = null
})

function openDetail(id: string) {
  router.push({ name: 'detail', params: { id } })
}

function fmtTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}
function formatCacheHit(cache: number, total: number): string {
  if (!total) return '0%'
  return (cache / total * 100).toFixed(2) + '%'
}

const SESSION_KEY_ABBREV: Record<string, string> = {
  'x-claude-code-session-id': 'CC',
  'session_id': 'Codex',
  'x-amp-thread-id': 'AMP',
  'x-grok-conv-id': 'Grok',
  'x-session-affinity': 'Affinity',
}

function sessionLabel(sid?: string, key?: string): string {
  if (!sid || !key) return '-'
  const abbrev = SESSION_KEY_ABBREV[key] ?? (key.endsWith('session-id') ? key.replace(/[-_]?session-id$/i, '').slice(0, 8) : key.slice(0, 6))
  return abbrev + ' ' + sid.slice(0, 8)
}
</script>

<template>
  <div class="list-page">
    <!-- 顶栏 -->
    <div class="top-bar">
      <div class="stats">
        <button class="stat-filter" :class="{ active: store.activeFilter === 'all' }" @click="store.setFilter('all')">总计 {{ store.counts.total }}</button>
        <button class="stat-filter" :class="{ active: store.activeFilter === 'openai' }" @click="store.setFilter('openai')">OpenAI {{ openaiCount }}</button>
        <button class="stat-filter" :class="{ active: store.activeFilter === 'anthropic' }" @click="store.setFilter('anthropic')">Anthropic {{ anthropicCount }}</button>
        <button class="stat-filter stat-streaming" :class="{ active: store.activeFilter === 'streaming' }" @click="store.setFilter('streaming')">进行中 {{ streamingCount }}</button>
        <button class="stat-filter" :class="{ active: store.activeFilter === 'error' }" @click="store.setFilter('error')">错误 {{ errorCount }}</button>
      </div>
      <div class="top-actions">
        <input v-model="searchQuery" placeholder="搜索路径、模型、请求、响应…" class="search-input" />
      </div>
    </div>

    <!-- 表格 -->
    <div class="list-view">
      <table v-if="filtered.length > 0">
        <colgroup>
          <col class="col-time" />
          <col class="col-api" />
          <col class="col-model" />
          <col class="col-status" />
          <col class="col-preview" />
          <col class="col-session" />
          <col class="col-duration" />
          <col class="col-cache" />
          <col class="col-speed" />
        </colgroup>
        <thead>
          <tr>
            <th>时间</th>
            <th>API</th>
            <th>模型</th>
            <th>状态</th>
            <th>预览</th>
            <th>会话</th>
            <th>耗时</th>
            <th>缓存命中</th>
            <th>速度</th>
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
            <td class="cell-status">
              <span v-if="r.state === 'streaming'" class="badge badge-streaming">传输中</span>
              <span v-else-if="r.status < 300" class="badge badge-ok">{{ r.status }}</span>
              <span v-else-if="r.status < 500" class="badge badge-warn">{{ r.status }}</span>
              <span v-else class="badge badge-err">{{ r.status }}</span>
            </td>
            <td class="cell-preview">
              <em v-if="r.state === 'streaming'" style="color:var(--accent);margin-right:4px;">流式传输中…</em>
              <span v-else>{{ r.preview }}</span>
            </td>
            <td class="cell-session" :title="r.sessionId || undefined">
              {{ sessionLabel(r.sessionId, r.sessionIdKey) }}
            </td>
            <td class="cell-duration">
              <template v-if="r.state === 'streaming'">…</template>
              <template v-else>{{ r.durationMs }}ms</template>
            </td>
            <td class="cell-cache">
              <template v-if="r.state !== 'streaming' && r.apiReportedInput">
                <span v-if="r.cacheRead" class="cache-hit">{{ formatCacheHit(r.cacheRead, r.apiReportedInput) }}</span>
                <span v-else class="cache-miss">未命中</span>
              </template>
              <template v-else>-</template>
            </td>
            <td class="cell-speed"><TokenSpeed :text="r.streamText" :start-time="new Date(r.timestamp).getTime()" :endpoint="detectApiEndpoint(r.path, r.apiType)" :state="r.state" :output-tokens="r.outputTokens" :duration-ms="r.durationMs" :model="r.model" /></td>
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
.list-page { width: min(100% - 80px, 1520px); margin: 0 auto; padding: 28px 0; }

.top-bar {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 24px; padding: 20px 24px; flex-wrap: wrap; gap: 12px;
  background: var(--bg-card); border-radius: var(--radius); box-shadow: var(--shadow);
}
.stats { display: flex; gap: 8px; font-size: 0.82rem; color: var(--text-secondary); font-weight: 500; flex-wrap: wrap; }
.stat-filter {
  border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent;
  padding: 5px 10px; color: var(--text-secondary); font: inherit; cursor: pointer; white-space: nowrap;
  transition: background .15s, border-color .15s, color .15s;
}
.stat-filter:hover { background: var(--bg-inset); border-color: var(--border); }
.stat-filter.active { background: #e0e7ff; border-color: #c7d2fe; color: #3730a3; }
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

.list-view {
  background: var(--bg-card); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden;
}

table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.col-time { width: 9.5%; }
.col-api { width: 8.5%; }
.col-model { width: 9%; }
.col-status { width: 6%; }
.col-preview { width: 31.5%; }
.col-session { width: 10.5%; }
.col-duration { width: 7.5%; }
.col-cache { width: 8%; }
.col-speed { width: 9.5%; }
thead { background: var(--bg-inset); border-bottom: 1px solid var(--border); }
th {
  text-align: center; padding: 11px 10px; font-size: 0.73rem;
  font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--text-secondary); white-space: nowrap;
}
td { padding: 12px 10px; font-size: 0.84rem; border-bottom: 1px solid var(--border); }
tbody tr { cursor: pointer; transition: background .12s; }
tbody tr:hover { background: #f5f6ff; }
tbody tr:last-child td { border-bottom: none; }

.cell-time { white-space: nowrap; color: var(--text-secondary); font-family: var(--font-mono); font-size: 0.78rem; text-align: center; }
.cell-model { overflow-wrap: anywhere; font-weight: 500; text-align: center; }
.cell-api { white-space: nowrap; font-size: 0.75rem; text-align: center; }
.cell-status { white-space: nowrap; text-align: center; }
.cell-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
.cell-session { white-space: nowrap; font-family: var(--font-mono); font-size: 0.76rem; color: var(--text-muted); text-align: center; }
.cell-duration { white-space: nowrap; color: var(--text-secondary); font-family: var(--font-mono); font-size: 0.78rem; text-align: center; }
.cell-cache { white-space: nowrap; font-size: 0.78rem; text-align: center; }
.cell-speed { white-space: nowrap; font-size: 0.78rem; color: var(--text-secondary); font-family: var(--font-mono); text-align: center; }
.cache-hit { color: var(--success); font-weight: 600; }
.cache-miss { color: var(--text-muted); }

.empty-state { text-align: center; padding: 64px 20px; color: var(--text-muted); font-size: 0.95rem; }

@media (max-width: 768px) {
  .list-page { width: calc(100% - 24px); }
  .top-bar { flex-wrap: wrap; gap: 12px; }
  .cell-preview { max-width: 120px; }
  .cell-model { max-width: 80px; }
}
</style>
