<script setup lang="ts">
import { ref, shallowRef, watch, onMounted, onUnmounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useRequestsStore } from '../stores/requests'
import type { RecordedRequest, GlobalNeighbors } from '../types'
import { fetchPrev, fetchNext, fetchNeighbors } from '../api'
import type { RequestContextAnalysis } from '../context-composition'
import { buildResponseCards } from '../response-flow'
import HeadersViewer from '../components/HeadersViewer.vue'
import JsonViewer from '../components/JsonViewer.vue'
import ToolCallCard from '../components/ToolCallCard.vue'
import StreamLive from '../components/StreamLive.vue'
import TokenSpeed from '../components/TokenSpeed.vue'
import DiffViewer from '../components/DiffViewer.vue'
import MessageFlow from '../components/MessageFlow.vue'
import UserMessageCard from '../components/UserMessageCard.vue'
import AssistantTextCard from '../components/AssistantTextCard.vue'
import AssistantThinkingCard from '../components/AssistantThinkingCard.vue'
import AssistantRefusalCard from '../components/AssistantRefusalCard.vue'
import RawJsonCard from '../components/RawJsonCard.vue'
import ContextComposition from '../components/ContextComposition.vue'

const route = useRoute()
const router = useRouter()
const store = useRequestsStore()
let detailGeneration = 0

const record = ref<RecordedRequest | null>(null)
const loading = ref(false)
const error = ref('')
const parsedBody = shallowRef<Record<string, unknown>>()
const parsedBodyCache = new Map<string, Record<string, unknown> | undefined>()
const contextAnalysis = shallowRef<RequestContextAnalysis>()
let requestAnalysisWorker: Worker | null = null

const id = computed(() => route.params.id as string)
const isStreaming = computed(() => record.value?.state === 'streaming')
const isOpenAI = computed(() => record.value?.apiType === 'openai')
function parseBody(body: unknown, label: string): Record<string, unknown> | undefined {
  if (!body) return undefined
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as Record<string, unknown>
    } catch (e) {
      console.warn(`[DetailView] ${label} JSON 解析失败: ${formatErrorChain(e)}`)
      return undefined
    }
  }
  return body as Record<string, unknown>
}

function parseRecordBody(target: RecordedRequest, label: string): Record<string, unknown> | undefined {
  if (parsedBodyCache.has(target.id)) return parsedBodyCache.get(target.id)
  const parsed = parseBody(target.requestBody, label)
  parsedBodyCache.set(target.id, parsed)
  return parsed
}

const latestUserMessage = computed(() => contextAnalysis.value?.latestUserMessage ?? '')
const responseCards = computed(() => record.value
  ? buildResponseCards(record.value.responseContent, record.value.apiEndpoint)
  : [])

/** 响应体 tab：'raw' | 'merged' */
const respBodyTab = ref<'raw' | 'merged'>('raw')
const requestBodyOpen = ref(false)
const responseBodyOpen = ref(false)
/** 合并后的响应内容 JSON（用于"合并"tab） */
const mergedContentText = computed(() =>
  record.value?.responseContent ? JSON.stringify(record.value.responseContent, null, 2) : ''
)

// ---- 会话导航 & diff ----
const prevRecord = ref<RecordedRequest | null>(null)
const nextRecord = ref<RecordedRequest | null>(null)
const previousParsedBody = shallowRef<Record<string, unknown>>()
const prevResolved = ref(false)
const nextResolved = ref(false)
const previousBodyResolved = ref(false)
let prevRequest: Promise<RecordedRequest | null> | null = null
let nextRequest: Promise<RecordedRequest | null> | null = null
const diffOpen = ref(false)
const diffDirection = ref<'prev' | 'next'>('prev')
const diffTab = ref<'reqHead' | 'reqBody' | 'resHead' | 'resBody'>('reqBody')
const diffMode = ref<'unified' | 'split'>('split')
const diffCollapsed = ref(true)
const diffLoading = ref(false)
const flowOpen = ref(false)
const flowLoading = ref(false)

const hasSession = computed(() => !!record.value?.sessionId)
const hasPrev = computed(() => hasSession.value && (!prevResolved.value || !!prevRecord.value))
const hasNext = computed(() => hasSession.value && (!nextResolved.value || !!nextRecord.value))

const diffViewerRef = ref<InstanceType<typeof DiffViewer> | null>(null)

/** 请求体标题摘要 */
const requestBodySummary = computed(() => contextAnalysis.value?.summary ?? '')

/** diff 对比的目标记录 */
const diffTarget = computed(() =>
  diffDirection.value === 'prev' ? prevRecord.value : nextRecord.value
)

/**
 * diff 的 old/new：prev 模式 old=prev new=cur；next 模式 old=cur new=next
 * 保证旧到新的方向正确
 */
function diffPair(field: (r: RecordedRequest) => unknown) {
  const t = diffTarget.value
  if (!t) return { old: '', new: '', oldLabel: '', newLabel: '' }
  const oldR = diffDirection.value === 'prev' ? t : record.value!
  const newR = diffDirection.value === 'prev' ? record.value! : t
  const short = (r: RecordedRequest) => r.id.slice(0, 8) + ' ' + new Date(r.timestamp).toLocaleTimeString('zh-CN')
  return {
    old: formatDiffJSON(field(oldR)),
    new: formatDiffJSON(field(newR)),
    oldLabel: short(oldR),
    newLabel: short(newR),
  }
}

/** diff 的四个维度 */
const diffHeadReq = computed(() => diffPair(r => r.requestHeaders))
const diffBodyReq = computed(() => diffPair(r => parseRecordBody(r, 'diff 请求体')))
const diffHeadRes = computed(() => diffPair(r => r.responseHeaders))
const diffBodyRes = computed(() => diffPair(r => r.responseContent))

const diffOld = computed(() => diffDirection.value === 'prev' ? diffTarget.value! : record.value!)
const diffNew = computed(() => diffDirection.value === 'prev' ? record.value! : diffTarget.value!)

function formatDiffJSON(val: unknown): string {
  if (!val) return ''
  if (typeof val === 'string') {
    try { return JSON.stringify(JSON.parse(val), null, 2) }
    catch (e) {
      console.warn(`[DetailView] diff JSON 格式化失败: ${formatErrorChain(e)}`)
      return val
    }
  }
  return JSON.stringify(val, null, 2)
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

function resetSessionNeighbors() {
  prevRecord.value = null
  nextRecord.value = null
  previousParsedBody.value = undefined
  prevResolved.value = false
  nextResolved.value = false
  previousBodyResolved.value = false
  prevRequest = null
  nextRequest = null
}

async function ensureSessionNeighbor(direction: 'prev' | 'next'): Promise<RecordedRequest | null> {
  if (!record.value?.sessionId) return null
  const inFlight = direction === 'prev' ? prevRequest : nextRequest
  if (inFlight) return inFlight
  const request = loadSessionNeighbor(direction)
  if (direction === 'prev') prevRequest = request
  else nextRequest = request
  try {
    return await request
  } finally {
    if (direction === 'prev' && prevRequest === request) prevRequest = null
    if (direction === 'next' && nextRequest === request) nextRequest = null
  }
}

async function loadSessionNeighbor(direction: 'prev' | 'next'): Promise<RecordedRequest | null> {
  const current = record.value
  if (!current?.sessionId) return null
  const generation = detailGeneration
  const recordId = current.id
  const resolved = direction === 'prev' ? prevResolved : nextResolved
  const target = direction === 'prev' ? prevRecord : nextRecord
  if (resolved.value) return target.value
  try {
    const neighbor = direction === 'prev'
      ? await fetchPrev(recordId)
      : await fetchNext(recordId)
    if (generation !== detailGeneration || record.value?.id !== recordId) return null
    target.value = neighbor
    resolved.value = true
    return target.value
  } catch (e) {
    console.warn(`[DetailView] 查询会话${direction === 'prev' ? '上一条' : '下一条'}请求失败: ${formatErrorChain(e)}`)
    return null
  }
}

async function goToPrev() {
  const target = await ensureSessionNeighbor('prev')
  if (target) router.push({ name: 'detail', params: { id: target.id } })
}

async function goToNext() {
  const target = await ensureSessionNeighbor('next')
  if (target) router.push({ name: 'detail', params: { id: target.id } })
}

async function openDiff(dir: 'prev' | 'next') {
  if (diffOpen.value && diffDirection.value === dir) { diffOpen.value = false; return }
  diffLoading.value = true
  try {
    const target = await ensureSessionNeighbor(dir)
    if (target) { diffDirection.value = dir; diffOpen.value = true }
  } finally {
    diffLoading.value = false
  }
}

async function openMessageFlow() {
  if (flowLoading.value || !record.value) return
  flowLoading.value = true
  try {
    parsedBody.value ??= parseRecordBody(record.value, '当前请求体')
    if (!parsedBody.value) return
    if (!previousBodyResolved.value) {
      const previous = await ensureSessionNeighbor('prev')
      if (!hasSession.value || prevResolved.value) {
        previousParsedBody.value = previous
          ? parseRecordBody(previous, '上一条请求体')
          : undefined
        previousBodyResolved.value = true
      }
    }
    flowOpen.value = true
  } finally {
    flowLoading.value = false
  }
}

function onRequestBodyToggle(event: Event) {
  requestBodyOpen.value = (event.currentTarget as HTMLDetailsElement).open
}

function onResponseBodyToggle(event: Event) {
  responseBodyOpen.value = (event.currentTarget as HTMLDetailsElement).open
}

function rawBodyText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

/** 流式文本：优先从 store.items（SSE 推送）取，fallback 到完整 record */
const streamText = computed(() => {
  const summary = store.items.find(r => r.id === id.value)
  return summary?.streamText ?? record.value?.streamText
})

async function load(detailId: string) {
  const generation = ++detailGeneration
  loading.value = true
  error.value = ''
  diffOpen.value = false
  flowOpen.value = false
  requestBodyOpen.value = false
  responseBodyOpen.value = false
  respBodyTab.value = 'raw'
  globalNeighbors.value = null
  parsedBody.value = undefined
  contextAnalysis.value = undefined
  parsedBodyCache.clear()
  resetSessionNeighbors()
  try {
    const r = await store.loadDetail(detailId)
    if (generation !== detailGeneration) return
    if (!r) { error.value = '请求未找到'; return }
    record.value = r
    analyzeRequestBody(r, generation)
    loadGlobalNeighbors(detailId, generation)
  } catch (e) {
    if (generation !== detailGeneration) return
    error.value = `加载失败: ${formatErrorChain(e)}`
  } finally {
    if (generation === detailGeneration) loading.value = false
  }
}

// 注册 streaming→done 回调，自动刷新
const initId = computed(() => route.params.id as string)
onMounted(() => {
  load(initId.value)
  store.onStreamDone = (doneId: string) => {
    if (doneId === route.params.id) load(doneId)
  }
  // 列表更新时只刷新轻量全局导航；会话相邻记录在用户操作时重新加载。
  store.onListUpdate = () => {
    loadGlobalNeighbors()
    resetSessionNeighbors()
  }
  document.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  store.onStreamDone = null
  store.onListUpdate = null
  document.removeEventListener('keydown', onKeydown)
  requestAnalysisWorker?.terminate()
  requestAnalysisWorker = null
})
watch(() => route.params.id as string, load)

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (diffOpen.value) diffOpen.value = false
    else if (flowOpen.value) flowOpen.value = false
  }
}

// ---- 全局导航（直接查接口，实时反映新记录插入） ----
const globalNeighbors = ref<GlobalNeighbors | null>(null)

async function loadGlobalNeighbors(detailId = id.value, generation = detailGeneration) {
  try {
    const neighbors = await fetchNeighbors(detailId)
    if (generation === detailGeneration && id.value === detailId) globalNeighbors.value = neighbors
  } catch (e) {
    if (generation !== detailGeneration || id.value !== detailId) return
    console.warn(`[DetailView] 加载全局导航失败: ${formatErrorChain(e)}`)
    globalNeighbors.value = null
  }
}
function globalPrev() {
  if (globalNeighbors.value?.prevId) router.push({ name: 'detail', params: { id: globalNeighbors.value.prevId } })
}
function globalNext() {
  if (globalNeighbors.value?.nextId) router.push({ name: 'detail', params: { id: globalNeighbors.value.nextId } })
}

function buildCurl(url: string): string {
  const r = record.value!
  const headers = r.requestHeaders ?? {}
  let cmd = `curl -X ${r.method} '${url}'`
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'accept-encoding') continue
    cmd += ` \\\n  -H '${k}: ${v}'`
  }
  if (r.requestBody && r.method !== 'GET' && r.method !== 'HEAD') {
    cmd += ` \\\n  -d '${JSON.stringify(r.requestBody).replace(/'/g, "'\\''")}'`
  }
  return cmd
}

function copyText(text: string) {
  const el = document.createElement('textarea')
  el.value = text
  el.style.position = 'fixed'; el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  document.execCommand('copy')
  document.body.removeChild(el)
}

async function doExport() {
  if (!record.value) return
  const r = record.value
  let out = `# SSEInspector Export\n\n`
  out += `| 字段 | 值 |\n|------|----|\n`
  out += `| ID | ${r.id} |\n| 时间 | ${new Date(r.timestamp).toLocaleString('zh-CN')} |\n`
  out += `| API | ${r.apiType} |\n| 耗时 | ${r.durationMs}ms |\n| 状态 | ${r.responseStatus} |\n\n`
  const ui = latestUserMessage.value
  if (ui) out += `## 用户请求\n\n${ui}\n\n`
  if (r.responseContent) out += `## 响应\n\n${JSON.stringify(r.responseContent, null, 2)}\n\n`
  copyText(out)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function analyzeRequestBody(target: RecordedRequest, generation: number) {
  if (!target.requestBody || (typeof target.requestBody !== 'string' && !isRecord(target.requestBody))) return
  requestAnalysisWorker ??= createRequestAnalysisWorker()
  requestAnalysisWorker.postMessage({
    generation,
    recordId: target.id,
    body: target.requestBody,
    endpoint: target.apiEndpoint,
  })
}

function createRequestAnalysisWorker(): Worker {
  const worker = new Worker(new URL('../workers/request-analysis.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<{
    generation: number
    recordId: string
    ok: boolean
    analysis?: RequestContextAnalysis
    error?: string
  }>) => {
    const result = event.data
    if (result.generation !== detailGeneration || result.recordId !== record.value?.id) return
    if (result.ok && result.analysis) {
      contextAnalysis.value = result.analysis
      return
    }
    console.warn(`[DetailView] 请求上下文分析失败: ${result.error ?? '未知错误'}`)
  }
  worker.onerror = event => {
    console.warn(`[DetailView] 请求分析 Worker 失败: ${event.message}`)
  }
  return worker
}
</script>

<template>
  <div class="detail-page">
    <!-- 导航栏 -->
    <div class="nav-bar">
      <button class="btn-back" @click="router.push({ name: 'list' })">&larr; 返回列表</button>
      <button v-if="record" class="btn-export" @click="doExport">导出</button>

      <span class="nav-sep"></span>

      <!-- 全局导航 -->
      <div class="nav-group">
        <span class="nav-group-label">全局</span>
        <button class="btn-nav" :disabled="!globalNeighbors?.prevId" @click="globalPrev">&#9650;</button>
        <span class="nav-pos">{{ globalNeighbors ? globalNeighbors.index : "-" }} / {{ globalNeighbors?.total ?? store.total }}</span>
        <button class="btn-nav" :disabled="!globalNeighbors?.nextId" @click="globalNext">&#9660;</button>
      </div>

      <span class="nav-sep"></span>

      <!-- 会话导航 -->
      <div class="nav-group">
        <span class="nav-group-label">会话</span>
        <button class="btn-nav" :disabled="!hasPrev" @click="goToPrev">&#9664;</button>
        <span class="nav-pos" v-if="hasSession">{{ prevRecord ? prevRecord.id.slice(0, 6) : '-' }} · {{ nextRecord ? nextRecord.id.slice(0, 6) : '-' }}</span>
        <span class="nav-pos" v-else>无</span>
        <button class="btn-nav" :disabled="!hasNext" @click="goToNext">&#9654;</button>
      </div>

      <span class="nav-sep"></span>

      <!-- Diff -->
      <div class="nav-group">
        <span class="nav-group-label">diff</span>
        <button class="btn-nav btn-diff" :disabled="diffLoading || !hasPrev" @click="openDiff('prev')" title="上一个 diff">&#9664;</button>
        <button class="btn-nav btn-diff" :disabled="diffLoading || !hasNext" @click="openDiff('next')" title="下一个 diff">&#9654;</button>
      </div>
    </div>

    <div v-if="loading && !record" class="status-msg">加载中…</div>
    <div v-else-if="error" class="status-msg error-msg">{{ error }}</div>

    <template v-if="record">
      <!-- Meta -->
      <div class="detail-meta">
        <span>ID: {{ record.id }}</span>
        <span>时间: {{ new Date(record.timestamp).toLocaleString('zh-CN') }}</span>
        <span>API: <span :class="`badge badge-${isOpenAI ? 'openai' : 'anthropic'}`">{{ isOpenAI ? 'OpenAI' : 'Anthropic' }}</span></span>
        <span>流式: {{ record.streaming ? '是' : '否' }}</span>
        <span>耗时: {{ isStreaming ? '…' : record.durationMs + 'ms' }}</span>
        <span>状态: <span :class="`badge ${record.responseStatus < 300 ? 'badge-ok' : record.responseStatus < 500 ? 'badge-warn' : 'badge-err'}`">{{ record.responseStatus }}</span></span>
        <span>速度: <TokenSpeed :state="record.state" :output-tokens="record.outputTokens" :duration-ms="record.durationMs" /></span>
        <span v-if="record.error" style="color:var(--error);font-weight:600;">错误: {{ record.error }}</span>
        <span v-if="isStreaming" style="color:var(--accent);font-weight:600;">● 传输中…</span>
      </div>


      <!-- Diff 弹窗 -->
      <Teleport to="body">
        <div v-if="diffOpen && diffTarget" class="diff-overlay" @click.self="diffOpen = false">
          <div class="diff-modal">
            <div class="diff-modal-header">
              <div class="diff-tabs-row">
                <button class="diff-tab" :class="{ active: diffTab === 'reqHead' }" @click="diffTab = 'reqHead'">请求头</button>
                <button class="diff-tab" :class="{ active: diffTab === 'reqBody' }" @click="diffTab = 'reqBody'">请求体</button>
                <button class="diff-tab" :class="{ active: diffTab === 'resHead' }" @click="diffTab = 'resHead'">响应头</button>
                <button class="diff-tab" :class="{ active: diffTab === 'resBody' }" @click="diffTab = 'resBody'">响应体</button>
              </div>
              <div class="diff-pair-info">
                <span class="diff-pair-old" :title="diffOld.id">--- {{ diffOld.id.slice(0,8) }} {{ new Date(diffOld.timestamp).toLocaleTimeString('zh-CN') }}</span>
                <span class="diff-pair-new" :title="diffNew.id">+++ {{ diffNew.id.slice(0,8) }} {{ new Date(diffNew.timestamp).toLocaleTimeString('zh-CN') }}</span>
              </div>
              <div class="diff-toolbar">
                <button class="diff-tool-btn" :class="{ active: diffCollapsed }" @click="diffCollapsed = !diffCollapsed" :title="diffCollapsed ? '展开全部' : '折叠上下文'">
                  {{ diffCollapsed ? '📋 折叠' : '📜 展开' }}
                </button>
                <button class="diff-tool-btn" :class="{ active: diffMode === 'unified' }" @click="diffMode = 'unified'" title="单栏模式">☰ 单栏</button>
                <button class="diff-tool-btn" :class="{ active: diffMode === 'split' }" @click="diffMode = 'split'" title="双栏模式">◫ 双栏</button>
                <span class="diff-tool-sep"></span>
                <button class="diff-tool-btn" @click="diffViewerRef?.jumpToChange('prev')" title="上一处变更">&#9650;</button>
                <button class="diff-tool-btn" @click="diffViewerRef?.jumpToChange('next')" title="下一处变更">&#9660;</button>
                <button class="diff-tool-btn diff-close-btn" @click="diffOpen = false" title="关闭 (Esc)">✕</button>
              </div>
            </div>
            <div class="diff-modal-body">
              <DiffViewer
                ref="diffViewerRef"
                v-if="diffTab === 'reqHead'"
                :old-string="diffHeadReq.old" :new-string="diffHeadReq.new"
                :old-label="`请求头 (${diffHeadReq.oldLabel})`" :new-label="`请求头 (${diffHeadReq.newLabel})`"
                :mode="diffMode" :collapsed="diffCollapsed" :context="3"
              />
              <DiffViewer
                ref="diffViewerRef"
                v-if="diffTab === 'reqBody'"
                :old-string="diffBodyReq.old" :new-string="diffBodyReq.new"
                :old-label="`请求体 (${diffBodyReq.oldLabel})`" :new-label="`请求体 (${diffBodyReq.newLabel})`"
                :mode="diffMode" :collapsed="diffCollapsed" :context="5"
              />
              <DiffViewer
                ref="diffViewerRef"
                v-if="diffTab === 'resHead'"
                :old-string="diffHeadRes.old" :new-string="diffHeadRes.new"
                :old-label="`响应头 (${diffHeadRes.oldLabel})`" :new-label="`响应头 (${diffHeadRes.newLabel})`"
                :mode="diffMode" :collapsed="diffCollapsed" :context="3"
              />
              <DiffViewer
                ref="diffViewerRef"
                v-if="diffTab === 'resBody'"
                :old-string="diffBodyRes.old" :new-string="diffBodyRes.new"
                :old-label="`响应体 (${diffBodyRes.oldLabel})`" :new-label="`响应体 (${diffBodyRes.newLabel})`"
                :mode="diffMode" :collapsed="diffCollapsed" :context="5"
              />
            </div>
          </div>
        </div>
      </Teleport>

      <!-- 请求地址 -->
      <div class="card request-url-card">
        <div class="card-title">请求地址</div>
        <div class="url-row">
          <code>{{ record.method }} {{ record.path }}</code>
          <button class="curl-btn" @click="copyText(buildCurl(record.path))">curl</button>
        </div>
        <div class="url-row" style="margin-top:10px">
          <code>{{ record.method }} {{ record.upstreamUrl }}</code>
          <button class="curl-btn" @click="copyText(buildCurl(record.upstreamUrl))">curl</button>
        </div>
      </div>

      <HeadersViewer title="请求头" :headers="record.requestHeaders" />

      <ContextComposition v-if="contextAnalysis" :analysis="contextAnalysis" />

      <!-- 请求体 -->
      <details class="headers-box" v-if="record.requestBody" :open="requestBodyOpen" @toggle="onRequestBodyToggle">
        <summary>
          请求体
          <span v-if="requestBodySummary" class="body-summary-meta">{{ requestBodySummary }}</span>
          <span class="body-summary-actions">
            <button class="curl-btn" :disabled="flowLoading" @click.prevent.stop="openMessageFlow">
              {{ flowLoading ? '加载中…' : '消息流' }}
            </button>
          </span>
        </summary>
        <JsonViewer v-if="requestBodyOpen" :value="rawBodyText(record.requestBody)" lang="json" />
      </details>

      <!-- 消息流弹窗 -->
      <Teleport to="body">
        <div v-if="flowOpen && parsedBody" class="diff-overlay" @click.self="flowOpen = false">
          <div class="diff-modal">
            <div class="diff-modal-header">
              <div class="diff-tabs-row">
                <span class="diff-title">消息流</span>
              </div>
              <div class="diff-toolbar">
                <button class="diff-tool-btn diff-close-btn" @click="flowOpen = false" title="关闭 (Esc)">✕</button>
              </div>
            </div>
            <div class="diff-modal-body flow-body">
              <MessageFlow
                :body="parsedBody"
                :previous-body="previousParsedBody"
                :api-endpoint="record.apiEndpoint"
              />
            </div>
          </div>
        </div>
      </Teleport>

      <!-- 用户请求 -->
      <UserMessageCard v-if="latestUserMessage" title="用户请求" :text="latestUserMessage" />

      <!-- 响应内容 -->
      <div v-if="isStreaming && streamText" class="card streaming-card">
        <span class="section-label label-streaming">实时接收中…</span>
        <StreamLive :text="streamText" />
      </div>

      <div v-else-if="record.responseContent && !isStreaming">
        <template v-for="card in responseCards" :key="card.id">
          <AssistantTextCard v-if="card.type === 'assistant_text'" :text="card.text" />
          <AssistantThinkingCard v-else-if="card.type === 'assistant_thinking'" :text="card.text" />
          <AssistantRefusalCard v-else-if="card.type === 'assistant_refusal'" :text="card.text" />
          <ToolCallCard
            v-else-if="card.type === 'tool_call'"
            :tool-call-id="card.callId"
            :tool-name="card.name"
            :tool-args="card.arguments"
          />
          <RawJsonCard v-else-if="card.type === 'raw_item'" :title="card.title" :value="card.value" />
          <div v-else-if="card.type === 'finish_reason'" class="finish-reason">
            结束原因: <span :class="`kv kv-finish kv-finish-${card.value}`">{{ card.value }}</span>
          </div>
        </template>
      </div>

      <!-- 响应头 -->
      <HeadersViewer title="响应头" :headers="record.responseHeaders ?? {}" />

      <!-- 响应体（原始 / 合并双 tab） -->
      <details class="details-card" v-if="record.responseBody" :open="responseBodyOpen" @toggle="onResponseBodyToggle">
        <summary>响应体</summary>
        <div class="rb-tabs">
          <button class="rb-tab" :class="{ active: respBodyTab === 'raw' }" @click="respBodyTab = 'raw'">原始</button>
          <button class="rb-tab" :class="{ active: respBodyTab === 'merged' }" @click="respBodyTab = 'merged'">合并</button>
        </div>
        <div v-if="responseBodyOpen && respBodyTab === 'raw'" class="rb-pane">
          <JsonViewer :value="record.responseBody" :lang="record.responseBody.startsWith('{') ? 'json' : 'plaintext'" />
        </div>
        <div v-else-if="responseBodyOpen" class="rb-pane">
          <JsonViewer :value="mergedContentText" lang="json" />
        </div>
      </details>

    </template>
  </div>
</template>

<style scoped>
.detail-page { max-width: 1280px; margin: 0 auto; padding: 28px 24px; }

/* Nav */
.nav-bar {
  display: flex; align-items: center; gap: 4px; margin-bottom: 16px; flex-wrap: wrap;
  padding: 10px 14px; background: var(--bg-card); border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
}

.btn-back {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--bg-card); color: var(--accent); border: 1px solid var(--border);
  padding: 8px 14px; border-radius: var(--radius-sm); cursor: pointer;
  font-size: 0.82rem; font-weight: 500; transition: all .15s;
}
.btn-back:hover { background: var(--accent); color: #fff; border-color: var(--accent); }

.btn-export {
  background: var(--bg-card); color: var(--text-secondary); border: 1px solid var(--border);
  padding: 8px 12px; border-radius: var(--radius-sm); cursor: pointer;
  font-size: 0.80rem; font-weight: 500; transition: all .15s;
}
.btn-export:hover { background: var(--success); color: #fff; border-color: var(--success); }

.nav-sep {
  width: 1px; height: 26px; background: var(--border); flex-shrink: 0;
}

.nav-group {
  display: inline-flex; align-items: center; gap: 2px;
}
.nav-group-label {
  font-size: 0.66rem; font-weight: 600; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.06em; margin-right: 2px;
}

.btn-nav {
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--bg-inset); color: var(--text-secondary); border: 1px solid var(--border);
  width: 28px; height: 28px; border-radius: var(--radius-sm); cursor: pointer;
  font-size: 0.74rem; transition: all .15s;
}
.btn-nav:hover:not(:disabled) { background: var(--accent); color: #fff; border-color: var(--accent); }
.btn-nav:disabled { opacity: .35; cursor: default; }

.nav-pos {
  font-size: 0.68rem; color: var(--text-muted); font-family: var(--font-mono);
  padding: 0 2px; min-width: 24px; text-align: center;
}

.btn-diff { width: auto; padding: 0 6px; }
.btn-diff:hover:not(:disabled) {
  background: #fef3c7; color: #92400e; border-color: #f59e0b;
}


/* Meta */
.detail-meta {
  display: flex; align-items: center; gap: 14px; flex-wrap: nowrap;
  font-size: 0.82rem; color: var(--text-secondary); margin-bottom: 16px;
  padding: 14px 18px; background: var(--bg-card); border-radius: var(--radius);
  box-shadow: var(--shadow-sm); overflow-x: auto;
}
.detail-meta span { font-family: var(--font-mono); font-size: 0.78rem; }

/* Cards */
.card {
  background: var(--bg-card); border-radius: var(--radius); padding: 18px 20px;
  margin-bottom: 12px; box-shadow: var(--shadow-sm);
}
.card + .card { margin-top: 0; }
.card-title {
  font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--text-secondary); font-weight: 600; margin-bottom: 8px;
}
.card-title .kv { text-transform: none; }

.request-url-card { padding: 14px 18px; }
.url-row { display: flex; align-items: center; gap: 12px; }
.url-row code {
  font-family: var(--font-mono); font-size: 0.82rem; color: var(--text-primary);
  background: var(--bg-inset); padding: 8px 14px; border-radius: var(--radius-sm);
  flex: 1; word-break: break-all;
}
.curl-btn {
  position: static; opacity: 1; width: auto; height: auto;
  padding: 8px 18px; font-family: var(--font-mono); font-size: 0.78rem;
  font-weight: 600; color: var(--accent); border: 1px solid var(--accent);
  border-radius: var(--radius-sm); cursor: pointer; white-space: nowrap; flex-shrink: 0;
}
.curl-btn:hover { background: var(--accent); color: #fff; }
.curl-btn::after { display: none; }

.details-card {
  background: var(--bg-card); border-radius: var(--radius);
  box-shadow: var(--shadow-sm); overflow: hidden; margin-bottom: 12px;
  padding: 0;
}
.details-card summary {
  cursor: pointer; padding: 12px 18px; font-size: 0.82rem;
  font-weight: 600; color: var(--text-secondary); user-select: none;
  position: relative;
}

/* Reasoning */
.reasoning-card { margin-bottom: 12px; }
.reasoning-card + .reasoning-card { margin-top: 0; }
.reasoning-content { border-top: 1px solid var(--border); }

/* Content */
.content-text { min-height: 40px; }

/* Anthropic blocks */
.content-blocks { display: flex; flex-direction: column; gap: 8px; }
.anthropic-block {
  background: var(--bg-card); border-radius: var(--radius); box-shadow: var(--shadow-sm); overflow: hidden;
}
.anthropic-block .block-header {
  padding: 10px 16px; font-size: 0.75rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid var(--border);
}
.anthropic-block .block-body { padding: 16px; font-size: 0.88rem; line-height: 1.65; }
.anthropic-block.text .block-header { background: #e8f5e9; color: #2e7d32; }
.anthropic-block.thinking .block-header { background: #e3f2fd; color: #1565c0; }
.anthropic-block.tool_use .block-header { background: #eef2ff; color: #4338ca; }

/* Section labels */
.label-reasoning { background: #e3f2fd; color: #1565c0; }
.label-content { background: #e8f5e9; color: #2e7d32; }
.label-tool { background: #eef2ff; color: #4338ca; }
.label-streaming { background: #e0e7ff; color: #3730a3; animation: pulse 1.5s ease-in-out infinite; }

/* Streaming */
.streaming-card .stream-card { border-left: none; }

/* Finish reason */
.finish-reason { font-size: 0.8rem; color: var(--text-secondary); margin-top: 8px; }

.status-msg { text-align: center; padding: 40px 0; color: var(--text-secondary); }
.error-msg { color: var(--error); }

/* Response body tabs */
.rb-tabs {
  display: flex; gap: 0; border-bottom: 1px solid var(--border); padding: 0 18px;
}
.rb-tab {
  padding: 8px 16px; border: none; background: none; cursor: pointer;
  font-size: 0.78rem; font-weight: 500; color: var(--text-muted);
  border-bottom: 2px solid transparent; margin-bottom: -1px; transition: all .15s;
}
.rb-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.rb-tab:hover:not(.active) { color: var(--text-secondary); }
.rb-pane { position: relative; }
.rb-pane .copy-btn { top: 4px; right: 4px; }

@media (max-width: 768px) {
  .detail-meta { flex-wrap: wrap; }
}

/* ---- Diff 弹窗 ---- */
.diff-overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0,0,0,.45);
  display: flex; align-items: stretch; justify-content: stretch;
}
.diff-modal {
  margin: 2vh 2vw; flex: 1; background: var(--bg-card);
  border-radius: var(--radius); box-shadow: var(--shadow-lg);
  display: flex; flex-direction: column; overflow: hidden;
}
.diff-modal-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 16px; border-bottom: 1px solid var(--border);
  background: var(--bg-inset); gap: 12px; flex-wrap: wrap;
}
.diff-tabs-row { display: flex; gap: 2px; }
.diff-tab {
  padding: 7px 14px; border: none; background: none; cursor: pointer;
  font-size: 0.78rem; font-weight: 500; color: var(--text-muted);
  border-radius: var(--radius-sm); transition: all .15s;
}
.diff-tab.active { background: var(--accent); color: #fff; }
.diff-tab:hover:not(.active) { color: var(--text-secondary); background: var(--bg-card); }

.diff-pair-info {
  display: flex; gap: 16px; font-family: var(--font-mono); font-size: 0.72rem; font-weight: 600;
}
.diff-pair-old { color: #c62828; }
.diff-pair-new { color: #2e7d32; }

.diff-toolbar { display: flex; gap: 6px; align-items: center; }
.diff-tool-btn {
  padding: 6px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-card); cursor: pointer; font-size: 0.76rem; font-weight: 500;
  color: var(--text-secondary); transition: all .15s;
}
.diff-tool-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.diff-tool-btn:hover:not(.active) { border-color: var(--accent); color: var(--accent); }
.diff-tool-sep { width: 1px; height: 20px; background: var(--border); margin: 0 4px; }
.diff-close-btn {
  font-size: 0.9rem; padding: 6px 10px; font-weight: 700;
}
.diff-close-btn:hover { background: var(--error); color: #fff; border-color: var(--error); }

.diff-modal-body {
  flex: 1; overflow: hidden; display: flex;
}
.diff-modal-body.flow-body {
  min-height: 0;
  overflow: hidden;
  padding: 0;
}
.diff-modal-body .diff-viewer {
  flex: 1; border: none; border-radius: 0; display: flex; flex-direction: column;
}
.diff-modal-body .diff-lines { flex: 1; }

.diff-title {
  font-size: 0.84rem; font-weight: 700; color: var(--accent);
  text-transform: uppercase; letter-spacing: 0.04em;
}

.headers-box {
  background: var(--bg-card); border-radius: var(--radius);
  box-shadow: var(--shadow-sm); overflow: hidden; margin-bottom: 12px; padding: 0;
}
.headers-box summary {
  cursor: pointer; padding: 12px 18px; font-size: 0.82rem;
  font-weight: 600; color: var(--text-secondary); user-select: none;
  position: relative;
}
.body-summary-actions {
  position: absolute; top: 50%; right: 14px; transform: translateY(-50%);
  line-height: 1;
}
.body-summary-meta {
  display: inline-block;
  max-width: calc(100% - 120px);
  margin-left: 12px;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--text-muted);
  vertical-align: middle;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
