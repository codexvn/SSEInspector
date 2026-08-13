<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useRequestsStore } from '../stores/requests'
import type { RecordSummary } from '../types'
import Pagination from '../components/Pagination.vue'
import TokenSpeed from '../components/TokenSpeed.vue'

const store = useRequestsStore()
const router = useRouter()
const searchQuery = ref('')

/** 展开的透传连续分组 id（默认折叠） */
const expandedPassthroughGroups = ref(new Set<string>())

const filtered = computed(() => {
  const q = searchQuery.value.toLowerCase().trim()
  if (!q) return store.items
  return store.items.filter(r => {
    const hay = [r.id, r.model, r.preview, r.apiType, r.path, String(r.status), r.state, r.sessionId, r.sessionIdKey].join('\n').toLowerCase()
    return hay.includes(q)
  })
})

type ListRow =
  | { kind: 'record'; record: RecordSummary; nested?: boolean }
  | {
      kind: 'passthrough-group'
      id: string
      items: RecordSummary[]
      expanded: boolean
    }

/** 将连续透传（≥2）收成分组；单条透传仍为普通行。 */
function groupConsecutivePassthrough(items: RecordSummary[], expanded: Set<string>): ListRow[] {
  const rows: ListRow[] = []
  let i = 0
  while (i < items.length) {
    const cur = items[i]
    if (cur.apiType !== 'passthrough') {
      rows.push({ kind: 'record', record: cur })
      i++
      continue
    }
    let j = i + 1
    while (j < items.length && items[j].apiType === 'passthrough') j++
    const run = items.slice(i, j)
    if (run.length < 2) {
      rows.push({ kind: 'record', record: cur })
    } else {
      const id = `${run[0].id}:${run[run.length - 1].id}:${run.length}`
      const isExpanded = expanded.has(id)
      rows.push({ kind: 'passthrough-group', id, items: run, expanded: isExpanded })
      if (isExpanded) {
        for (const rec of run) rows.push({ kind: 'record', record: rec, nested: true })
      }
    }
    i = j
  }
  return rows
}

const listRows = computed(() => groupConsecutivePassthrough(filtered.value, expandedPassthroughGroups.value))

// 列表数据变化时清掉已不存在的 expanded id，避免 Set 无限涨
watch(filtered, (items) => {
  if (expandedPassthroughGroups.value.size === 0) return
  const valid = new Set<string>()
  let i = 0
  while (i < items.length) {
    if (items[i].apiType !== 'passthrough') { i++; continue }
    let j = i + 1
    while (j < items.length && items[j].apiType === 'passthrough') j++
    if (j - i >= 2) {
      const run = items.slice(i, j)
      valid.add(`${run[0].id}:${run[run.length - 1].id}:${run.length}`)
    }
    i = j
  }
  const next = new Set<string>()
  for (const id of expandedPassthroughGroups.value) {
    if (valid.has(id)) next.add(id)
  }
  expandedPassthroughGroups.value = next
})

function togglePassthroughGroup(id: string) {
  const next = new Set(expandedPassthroughGroups.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedPassthroughGroups.value = next
}

function groupPreview(items: RecordSummary[]): string {
  const paths = new Map<string, number>()
  for (const r of items) {
    const key = r.preview || `${r.path || ''}`.trim() || '(无预览)'
    paths.set(key, (paths.get(key) ?? 0) + 1)
  }
  const parts = [...paths.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([text, n]) => (n > 1 ? `${text} ×${n}` : text))
  const more = paths.size > 3 ? ` 等 ${paths.size} 种` : ''
  return parts.join(' · ') + more
}

function groupTimeRange(items: RecordSummary[]): string {
  if (!items.length) return ''
  // 列表按时间 DESC：首条最新，末条最旧
  const newest = fmtTime(items[0].timestamp)
  const oldest = fmtTime(items[items.length - 1].timestamp)
  return newest === oldest ? newest : `${oldest} – ${newest}`
}

function groupStatusSummary(items: RecordSummary[]): string {
  let ok = 0
  let err = 0
  let streaming = 0
  for (const r of items) {
    if (r.state === 'streaming') streaming++
    else if (r.state === 'error' || r.status >= 400) err++
    else ok++
  }
  const parts: string[] = []
  if (ok) parts.push(`${ok} 成功`)
  if (err) parts.push(`${err} 错误`)
  if (streaming) parts.push(`${streaming} 进行中`)
  return parts.join(' · ') || `${items.length} 条`
}

const openaiCount = computed(() => store.counts.openai)
const anthropicCount = computed(() => store.counts.anthropic)
const passthroughCount = computed(() => store.counts.passthrough)
const streamingCount = computed(() => store.counts.streaming)
const errorCount = computed(() => store.counts.error)

/** 当前会话筛选的展示标签：从已加载记录中查找会话头来源以复用 sessionLabel */
const activeSessionLabel = computed(() => {
  const sid = store.sessionFilter
  if (!sid) return ''
  const row = store.items.find(r => r.sessionId === sid)
  return sessionLabel(sid, row?.sessionIdKey)
})

function clearSessionFilter() {
  store.setSessionFilter(store.sessionFilter)
}

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
        <button class="stat-filter" :class="{ active: store.activeFilter === 'passthrough' }" @click="store.setFilter('passthrough')">透传 {{ passthroughCount }}</button>
        <button class="stat-filter stat-streaming" :class="{ active: store.activeFilter === 'streaming' }" @click="store.setFilter('streaming')">进行中 {{ streamingCount }}</button>
        <button class="stat-filter" :class="{ active: store.activeFilter === 'error' }" @click="store.setFilter('error')">错误 {{ errorCount }}</button>
      </div>
      <div class="top-actions">
        <span v-if="store.sessionFilter" class="session-chip" :title="store.sessionFilter">
          会话: {{ activeSessionLabel }}
          <button class="session-chip-close" @click="clearSessionFilter" title="清除会话筛选">×</button>
        </span>
        <input v-model="searchQuery" placeholder="搜索路径、模型、请求、响应…" class="search-input" />
      </div>
    </div>

    <!-- 表格 -->
    <div class="list-view">
      <table v-if="listRows.length > 0">
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
          <template v-for="row in listRows" :key="row.kind === 'record' ? row.record.id : row.id">
            <!-- 连续透传分组头 -->
            <tr
              v-if="row.kind === 'passthrough-group'"
              class="passthrough-group-row"
              :class="{ expanded: row.expanded }"
              @click="togglePassthroughGroup(row.id)"
            >
              <td class="cell-time group-time">{{ groupTimeRange(row.items) }}</td>
              <td class="cell-api">
                <span class="badge badge-passthrough">透传</span>
              </td>
              <td class="cell-model group-count">×{{ row.items.length }}</td>
              <td class="cell-status group-status">{{ groupStatusSummary(row.items) }}</td>
              <td class="cell-preview group-preview" :title="groupPreview(row.items)">
                <span class="group-chevron" aria-hidden="true">{{ row.expanded ? '▼' : '▶' }}</span>
                <span class="group-label">连续透传 {{ row.items.length }} 条</span>
                <span class="group-paths">{{ groupPreview(row.items) }}</span>
              </td>
              <td class="cell-session">-</td>
              <td class="cell-duration">-</td>
              <td class="cell-cache">-</td>
              <td class="cell-speed group-toggle">{{ row.expanded ? '收起' : '展开' }}</td>
            </tr>
            <!-- 普通记录 / 展开后的透传子行 -->
            <tr
              v-else
              :class="{ 'nested-passthrough': row.nested }"
              @click="openDetail(row.record.id)"
            >
              <td class="cell-time">{{ fmtTime(row.record.timestamp) }}</td>
              <td class="cell-api">
                <span v-if="row.record.apiType === 'passthrough'" class="badge badge-passthrough">透传</span>
                <span v-else-if="row.record.apiType === 'anthropic'" class="badge badge-anthropic">Anthropic</span>
                <span v-else class="badge badge-openai">OpenAI</span>
              </td>
              <td class="cell-model" :title="row.record.apiType === 'passthrough' ? undefined : row.record.model">{{ row.record.apiType === 'passthrough' ? '-' : row.record.model }}</td>
              <td class="cell-status">
                <span v-if="row.record.state === 'streaming'" class="badge badge-streaming">传输中</span>
                <span v-else-if="row.record.status < 300" class="badge badge-ok">{{ row.record.status }}</span>
                <span v-else-if="row.record.status < 500" class="badge badge-warn">{{ row.record.status }}</span>
                <span v-else class="badge badge-err">{{ row.record.status }}</span>
              </td>
              <td class="cell-preview">
                <em v-if="row.record.state === 'streaming'" style="color:var(--accent);margin-right:4px;">流式传输中…</em>
                <span v-else>{{ row.record.preview }}</span>
              </td>
              <td class="cell-session" :title="row.record.sessionId || undefined">
                <span
                  v-if="row.record.sessionId"
                  class="session-link"
                  :class="{ active: store.sessionFilter === row.record.sessionId }"
                  @click.stop="store.setSessionFilter(row.record.sessionId)"
                >{{ sessionLabel(row.record.sessionId, row.record.sessionIdKey) }}</span>
                <span v-else>-</span>
              </td>
              <td class="cell-duration">
                <template v-if="row.record.state === 'streaming'">…</template>
                <template v-else>{{ row.record.durationMs }}ms</template>
              </td>
              <td class="cell-cache">
                <template v-if="row.record.state !== 'streaming' && row.record.apiReportedInput">
                  <span v-if="row.record.cacheRead" class="cache-hit">{{ formatCacheHit(row.record.cacheRead, row.record.apiReportedInput) }}</span>
                  <span v-else class="cache-miss">未命中</span>
                </template>
                <template v-else>-</template>
              </td>
              <td class="cell-speed"><TokenSpeed :state="row.record.state" :output-tokens="row.record.outputTokens" :duration-ms="row.record.durationMs" /></td>
            </tr>
          </template>
        </tbody>
      </table>

      <div v-else class="empty-state">
        {{ searchQuery ? '无匹配请求' : (store.sessionFilter ? '当前会话无记录' : '暂无记录，发送请求到代理即可看到') }}
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
.session-link { cursor: pointer; padding: 2px 6px; border-radius: var(--radius-sm); transition: background .15s, color .15s; }
.session-link:hover { background: var(--bg-inset); color: var(--text-secondary); }
.session-link.active { background: #e0e7ff; color: #3730a3; }
.session-chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px;
  border-radius: var(--radius-sm); background: #e0e7ff; color: #3730a3;
  font-size: 0.78rem; font-family: var(--font-mono); white-space: nowrap;
  max-width: 240px; overflow: hidden; text-overflow: ellipsis;
}
.session-chip-close {
  border: none; background: transparent; color: #3730a3; cursor: pointer;
  font-size: 0.95rem; line-height: 1; padding: 0; margin-left: 2px;
}
.session-chip-close:hover { color: #1e1b4b; }
.cell-duration { white-space: nowrap; color: var(--text-secondary); font-family: var(--font-mono); font-size: 0.78rem; text-align: center; }
.cell-cache { white-space: nowrap; font-size: 0.78rem; text-align: center; }
.cell-speed { white-space: nowrap; font-size: 0.78rem; color: var(--text-secondary); font-family: var(--font-mono); text-align: center; }
.cache-hit { color: var(--success); font-weight: 600; }
.cache-miss { color: var(--text-muted); }

/* 连续透传分组 */
.passthrough-group-row {
  background: #f8fafc;
}
.passthrough-group-row:hover { background: #eef2ff; }
.passthrough-group-row.expanded { background: #eef2ff; }
.group-chevron {
  display: inline-block;
  width: 1em;
  color: var(--text-muted);
  font-size: 0.7rem;
  margin-right: 6px;
}
.group-label {
  font-weight: 600;
  color: #374151;
  margin-right: 8px;
}
.group-paths {
  color: var(--text-muted);
  font-size: 0.8rem;
}
.group-count {
  font-family: var(--font-mono);
  font-weight: 600;
  color: #4b5563;
}
.group-status {
  font-size: 0.72rem;
  color: var(--text-muted);
  white-space: normal;
  line-height: 1.3;
}
.group-time {
  font-size: 0.72rem;
  white-space: normal;
  line-height: 1.35;
}
.group-toggle {
  font-size: 0.75rem;
  color: #4338ca;
  font-weight: 600;
}
.nested-passthrough td {
  background: #fafbff;
}
.nested-passthrough .cell-time {
  padding-left: 18px;
}
.nested-passthrough .cell-preview {
  padding-left: 14px;
  border-left: 2px solid #c7d2fe;
}

.empty-state { text-align: center; padding: 64px 20px; color: var(--text-muted); font-size: 0.95rem; }

@media (max-width: 768px) {
  .list-page { width: calc(100% - 24px); }
  .top-bar { flex-wrap: wrap; gap: 12px; }
  .cell-preview { max-width: 120px; }
  .cell-model { max-width: 80px; }
}
</style>
