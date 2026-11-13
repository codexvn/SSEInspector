<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { fetchRetention, fetchRouting, retentionArchiveUrl, runRetention, saveRetention, saveRouting } from '../api'
import type { RetentionArchiveEntry, RetentionConfig, RoutingState, UpstreamRoute } from '../types'
import { formatBytes } from '../format'
import { formatErrorChain } from '../error'

const router = useRouter()

const loading = ref(true)
const error = ref('')
const saving = ref(false)
/** 保存失败的错误信息（含后端校验清单），展示后随下次保存清空 */
const saveErrors = ref<string[]>([])
const state = ref<RoutingState | null>(null)

/** 草稿：默认上游（空串表示不设默认）与规则数组，保存时整文档替换 */
const defaultUpstream = ref('')
const routes = ref<UpstreamRoute[]>([])
const loadedSnapshot = ref('')

function serializeDraft(): string {
  return JSON.stringify({ defaultUpstream: defaultUpstream.value.trim() || null, routes: routes.value })
}

const dirty = computed(() => serializeDraft() !== loadedSnapshot.value)

/** CLI 显式传入 --upstream 时覆盖界面值，提示用户界面值当前不生效 */
const cliOverridden = computed(() =>
  state.value?.cliUpstream != null && state.value.cliUpstream !== state.value.persistedDefault,
)

onMounted(async () => {
  try {
    const loaded = await fetchRouting()
    state.value = loaded
    defaultUpstream.value = loaded.persistedDefault ?? ''
    routes.value = loaded.routes.map(route => ({ ...route }))
    loadedSnapshot.value = serializeDraft()
  } catch (e) {
    error.value = `加载失败: ${formatErrorChain(e)}`
  } finally {
    loading.value = false
  }
  // 轮转状态独立加载：失败不阻塞分流配置的展示
  try {
    await refreshRetention()
  } catch (e) {
    retentionErrors.value = [`轮转状态加载失败: ${formatErrorChain(e)}`]
  }
})

function moveRoute(index: number, offset: -1 | 1): void {
  const target = index + offset
  if (target < 0 || target >= routes.value.length) return
  const [item] = routes.value.splice(index, 1)
  routes.value.splice(target, 0, item)
}

function removeRoute(index: number): void {
  routes.value.splice(index, 1)
}

const adding = ref({ name: '', prefix: '', upstream: '' })
const addError = ref('')

function addRoute(): void {
  const prefix = adding.value.prefix.trim()
  const upstream = adding.value.upstream.trim()
  if (!prefix || !upstream) {
    addError.value = '前缀与上游均为必填'
    return
  }
  addError.value = ''
  routes.value.push({
    id: crypto.randomUUID(),
    name: adding.value.name.trim(),
    enabled: true,
    prefix,
    upstream,
  })
  adding.value = { name: '', prefix: '', upstream: '' }
}

async function onSave(): Promise<void> {
  saving.value = true
  saveErrors.value = []
  try {
    const saved = await saveRouting({
      defaultUpstream: defaultUpstream.value.trim() || null,
      routes: routes.value,
    })
    state.value = saved
    defaultUpstream.value = saved.persistedDefault ?? ''
    routes.value = saved.routes.map(route => ({ ...route }))
    loadedSnapshot.value = serializeDraft()
  } catch (e) {
    saveErrors.value = [formatErrorChain(e)]
  } finally {
    saving.value = false
  }
}

// ---- 数据轮转（独立于分流配置的保存与执行）----

const retention = ref<RetentionConfig>({ enabled: false, triggerCount: 0, keepCount: 0 })
const retentionTotal = ref(0)
const archives = ref<RetentionArchiveEntry[]>([])
const retentionSnapshot = ref('')
const retentionLoaded = ref(false)
const retentionSaving = ref(false)
const retentionErrors = ref<string[]>([])
const retentionRunning = ref(false)
const runResult = ref('')

const retentionDirty = computed(() => JSON.stringify(retention.value) !== retentionSnapshot.value)
// 任一操作进行中互斥：立即轮转按磁盘上已保存的配置执行，保存未落盘时执行会用到旧值
const retentionBusy = computed(() => retentionSaving.value || retentionRunning.value)

async function refreshRetention(): Promise<void> {
  const loaded = await fetchRetention()
  retention.value = { ...loaded.config }
  retentionTotal.value = loaded.total
  archives.value = loaded.archives
  retentionSnapshot.value = JSON.stringify(retention.value)
  retentionLoaded.value = true
}

async function onSaveRetention(): Promise<void> {
  retentionSaving.value = true
  retentionErrors.value = []
  try {
    const saved = await saveRetention({ ...retention.value })
    retention.value = { ...saved }
    retentionSnapshot.value = JSON.stringify(retention.value)
  } catch (e) {
    retentionErrors.value = [formatErrorChain(e)]
  } finally {
    retentionSaving.value = false
  }
}

async function onRunRetention(): Promise<void> {
  retentionRunning.value = true
  runResult.value = ''
  try {
    const result = await runRetention()
    if (result.rotated) {
      runResult.value = `已轮转：删除 ${result.deleted} 条并归档为 ${result.archivedFile}（剩余 ${result.total} 条）`
    } else if (result.enabled) {
      runResult.value = `未超限：当前 ${result.total} 条，未执行轮转`
    } else {
      runResult.value = '轮转未启用'
    }
  } catch (e) {
    runResult.value = `执行失败: ${formatErrorChain(e)}`
  } finally {
    retentionRunning.value = false
  }
  // 轮转已生效，刷新失败只提示、不覆盖执行结果
  try {
    await refreshRetention()
  } catch (e) {
    retentionErrors.value = [`轮转状态刷新失败: ${formatErrorChain(e)}`]
  }
}

function formatArchiveTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <div class="settings-page">
    <div class="settings-header">
      <button class="back-btn" @click="router.push({ name: 'list' })">← 返回</button>
      <h1>分流设置</h1>
      <span v-if="dirty" class="dirty-hint">有未保存的修改</span>
      <button class="save-btn" :disabled="!dirty || saving" @click="onSave">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </div>

    <div v-if="loading" class="placeholder">加载中…</div>
    <div v-else-if="error" class="placeholder error">{{ error }}</div>
    <template v-else>
      <section class="card">
        <div class="section-label">默认上游</div>
        <p class="hint">
          未命中任何分流规则的请求转发到此地址；留空表示不设默认——此时未命中规则的请求会被拒绝（503）。
        </p>
        <div class="default-row">
          <input
            v-model="defaultUpstream"
            placeholder="如 http://10.10.0.51:23620（留空表示不设默认）"
            class="text-input"
            :disabled="cliOverridden"
          />
          <span v-if="cliOverridden" class="override-hint">
            CLI --upstream 已指定 {{ state?.cliUpstream }}，本次运行以此为准，界面值不生效
          </span>
        </div>
      </section>

      <section class="card">
        <div class="section-label">分流规则</div>
        <p class="hint">
          自上而下取第一条启用且前缀命中的规则（按路径段边界匹配，/v1 命中 /v1/... 但不命中 /v1foo）；
          命中时前缀按挂载点语义剥离后转发（/easytier/v1/models → 上游收到 /v1/models），需要保留前缀时把它写进上游地址的路径；
          上游为 http(s) 地址，允许携带路径前缀（与剥离后的路径拼接）。修改后需点击「保存」，保存即时生效、无需重启。
        </p>
        <table v-if="routes.length > 0" class="routes-table">
          <thead>
            <tr>
              <th class="col-order">顺序</th>
              <th class="col-enabled">启用</th>
              <th>名称</th>
              <th>路径前缀</th>
              <th>上游</th>
              <th class="col-op">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(route, index) in routes" :key="route.id" :class="{ disabled: !route.enabled }">
              <td class="col-order">
                <button class="mini-btn" :disabled="index === 0" title="上移" @click="moveRoute(index, -1)">↑</button>
                <button class="mini-btn" :disabled="index === routes.length - 1" title="下移" @click="moveRoute(index, 1)">↓</button>
              </td>
              <td class="col-enabled">
                <input v-model="route.enabled" type="checkbox" />
              </td>
              <td><input v-model="route.name" class="text-input" placeholder="可选" /></td>
              <td><input v-model="route.prefix" class="text-input mono" placeholder="/v1/messages" /></td>
              <td><input v-model="route.upstream" class="text-input mono" placeholder="http://host:port" /></td>
              <td class="col-op">
                <button class="mini-btn danger" title="删除" @click="removeRoute(index)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty-rules">暂无规则；未命中规则的请求将走默认上游。</div>

        <div class="add-row">
          <input v-model="adding.name" class="text-input" placeholder="名称（可选）" />
          <input v-model="adding.prefix" class="text-input mono" placeholder="路径前缀，如 /beta" />
          <input v-model="adding.upstream" class="text-input mono" placeholder="上游，如 http://10.0.0.1:8000" />
          <button class="mini-btn" @click="addRoute">添加</button>
        </div>
        <div v-if="addError" class="error">{{ addError }}</div>
      </section>

      <section class="card">
        <div class="section-label">数据轮转</div>
        <p class="hint">
          按数据量轮转：记录总数超过「触发阈值」时，把最老的记录删除到只剩「保留量」，删除前自动导出为归档文件（可下载）。
          后台每 60 秒探查一次，也可立即手动执行。启用时两个阈值必填，且保留量须小于触发阈值。
        </p>
        <p v-if="!retention.enabled" class="warn-hint">未启用轮转：录制数据将持续累积（当前 {{ retentionTotal }} 条）。</p>

        <div class="retention-row">
          <label class="retention-toggle">
            <input v-model="retention.enabled" type="checkbox" />
            启用轮转
          </label>
          <label>触发阈值 <input v-model.number="retention.triggerCount" class="text-input mono num" type="number" min="1" placeholder="如 100000" /></label>
          <label>保留量 <input v-model.number="retention.keepCount" class="text-input mono num" type="number" min="1" placeholder="如 80000" /></label>
          <button class="save-btn retention-save" :disabled="!retentionLoaded || !retentionDirty || retentionBusy" @click="onSaveRetention">
            {{ retentionSaving ? '保存中…' : '保存轮转配置' }}
          </button>
          <button class="mini-btn" :disabled="retentionBusy" @click="onRunRetention">
            {{ retentionRunning ? '执行中…' : '立即轮转' }}
          </button>
        </div>
        <div v-if="retention.enabled" class="hint">当前 {{ retentionTotal }} 条，超过 {{ retention.triggerCount }} 条时自动清理至 {{ retention.keepCount }} 条。</div>
        <div v-if="runResult" class="run-result" :class="{ 'run-result-error': runResult.startsWith('执行失败') }">{{ runResult }}</div>
        <div v-if="retentionErrors.length > 0" class="save-errors">
          <div v-for="(message, index) in retentionErrors" :key="index">{{ message }}</div>
        </div>

        <table v-if="archives.length > 0" class="routes-table archives-table">
          <thead>
            <tr>
              <th>归档文件</th>
              <th>大小</th>
              <th>时间</th>
              <th class="col-op">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in archives" :key="entry.name">
              <td class="mono">{{ entry.name }}</td>
              <td>{{ formatBytes(entry.size) }}</td>
              <td>{{ formatArchiveTime(entry.modifiedAt) }}</td>
              <td class="col-op"><a class="mini-btn download-link" :href="retentionArchiveUrl(entry.name)" :download="entry.name">下载</a></td>
            </tr>
          </tbody>
        </table>
      </section>

      <div v-if="saveErrors.length > 0" class="save-errors">
        <div v-for="(message, index) in saveErrors" :key="index">{{ message }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.settings-page {
  max-width: 960px;
  margin: 0 auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.settings-header {
  display: flex;
  align-items: center;
  gap: 12px;
}
.settings-header h1 {
  font-size: 1.2rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.back-btn {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 0.84rem;
  cursor: pointer;
}
.back-btn:hover { border-color: var(--accent); color: var(--accent); }

.dirty-hint {
  color: var(--text-muted);
  font-size: 0.82rem;
}

.save-btn {
  margin-left: auto;
  padding: 8px 22px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #fff;
  font-size: 0.86rem;
  cursor: pointer;
}
.save-btn:disabled { opacity: 0.45; cursor: default; }

.card {
  background: var(--bg-card);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 16px 20px;
}

.hint {
  color: var(--text-muted);
  font-size: 0.82rem;
  margin: 8px 0 12px;
  line-height: 1.6;
}

.warn-hint {
  color: var(--warning);
  font-size: 0.82rem;
  margin: 0 0 8px;
}

.retention-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.retention-row label {
  font-size: 0.85rem;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
}
.retention-toggle { cursor: pointer; }
.num { width: 130px; }

.run-result {
  font-size: 0.84rem;
  color: var(--accent);
  margin: 8px 0;
}
.run-result-error { color: var(--error); }

.archives-table td { font-size: 0.84rem; }
.download-link {
  text-decoration: none;
  display: inline-block;
}

.default-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.default-row .text-input { flex: 1; }

.override-hint {
  color: var(--warning);
  font-size: 0.8rem;
  white-space: nowrap;
}

.text-input {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 0.84rem;
  color: var(--text-primary);
  background: var(--bg);
  outline: none;
  width: 100%;
  box-sizing: border-box;
}
.text-input:focus { border-color: var(--accent); }
.text-input:disabled { opacity: 0.55; }
.mono { font-family: var(--font-mono); }

.routes-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 12px;
}
.routes-table th {
  text-align: left;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-muted);
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.routes-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.routes-table tr.disabled td { opacity: 0.55; }
.col-order { width: 76px; white-space: nowrap; }
.col-enabled { width: 48px; text-align: center; }
.col-op { width: 60px; }

.mini-btn {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text-primary);
  font-size: 0.8rem;
  cursor: pointer;
}
.mini-btn:disabled { opacity: 0.4; cursor: default; }
.mini-btn.danger:hover { border-color: var(--error); color: var(--error); }

.empty-rules {
  color: var(--text-muted);
  font-size: 0.84rem;
  padding: 12px 0;
}

.add-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.add-row .text-input { flex: 1; }
.add-row .mini-btn { padding: 8px 14px; white-space: nowrap; }

.error {
  color: var(--error);
  font-size: 0.82rem;
  margin-top: 8px;
}

.save-errors {
  background: var(--bg-card);
  border: 1px solid var(--error);
  border-radius: var(--radius);
  padding: 12px 16px;
  color: var(--error);
  font-size: 0.84rem;
  line-height: 1.6;
}

.placeholder {
  color: var(--text-muted);
  padding: 40px;
  text-align: center;
  background: var(--bg-card);
  border-radius: var(--radius);
}
.placeholder.error { color: var(--error); }
</style>
