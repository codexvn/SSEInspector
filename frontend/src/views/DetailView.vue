<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useRequestsStore } from '../stores/requests'
import type { RecordedRequest, ToolCallEntry } from '../types'
import { fetchToolCalls } from '../api'
import TokenBreakdown from '../components/TokenBreakdown.vue'
import HeadersViewer from '../components/HeadersViewer.vue'
import JsonViewer from '../components/JsonViewer.vue'
import ToolCallCard from '../components/ToolCallCard.vue'
import StreamLive from '../components/StreamLive.vue'

const route = useRoute()
const router = useRouter()
const store = useRequestsStore()

const record = ref<RecordedRequest | null>(null)
const loading = ref(false)
const error = ref('')
const toolCalls = ref<ToolCallEntry[]>([])

const id = computed(() => route.params.id as string)
const isStreaming = computed(() => record.value?.state === 'streaming')
const isOpenAI = computed(() => record.value?.apiType === 'openai')
const isAnthropic = computed(() => record.value?.apiType === 'anthropic')
/** requestBody 在服务器端透传 raw string（不 JSON.parse），前端惰性解析后缓存 */
const parsedBody = computed(() => {
  const body = record.value?.requestBody
  if (!body) return undefined
  if (typeof body === 'string') {
    try { return JSON.parse(body) as Record<string, unknown> } catch { return undefined }
  }
  return body as Record<string, unknown>
})

/** 响应体 tab：'raw' | 'merged' */
const respBodyTab = ref<'raw' | 'merged'>('raw')
/** 合并后的响应内容 JSON（用于"合并"tab） */
const mergedContentText = computed(() =>
  record.value?.responseContent ? JSON.stringify(record.value.responseContent, null, 2) : ''
)

/** 流式文本：优先从 store.items（SSE 推送）取，fallback 到完整 record */
const streamText = computed(() => {
  const summary = store.items.find(r => r.id === id.value)
  return summary?.streamText ?? record.value?.streamText
})

async function load(detailId: string) {
  loading.value = true
  error.value = ''
  try {
    const r = await store.loadDetail(detailId)
    if (!r) { error.value = '请求未找到'; return }
    record.value = r
    try {
      const tc = await fetchToolCalls(r.id)
      toolCalls.value = tc.toolCalls ?? []
    } catch { toolCalls.value = [] }
  } catch (e) {
    error.value = `加载失败: ${(e as Error).message}`
  } finally {
    loading.value = false
  }
}

// 注册 streaming→done 回调，自动刷新
const initId = computed(() => route.params.id as string)
onMounted(() => {
  load(initId.value)
  store.onStreamDone = (doneId: string) => {
    if (doneId === route.params.id) load(doneId)
  }
  document.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  store.onStreamDone = null
  document.removeEventListener('keydown', onKeydown)
})
watch(() => route.params.id as string, load)

function onKeydown(e: KeyboardEvent) {
  if (e.target !== document.body) return
  if (e.key === 'ArrowLeft') navigate(1)
  if (e.key === 'ArrowRight') navigate(-1)
}

function navigate(delta: number) {
  const idx = store.items.findIndex(r => r.id === id.value)
  if (idx < 0) return
  const next = store.items[idx + delta]
  if (next) router.push({ name: 'detail', params: { id: next.id } })
}

function fmtJson(val: unknown): string {
  if (typeof val === 'string') {
    try { return JSON.stringify(JSON.parse(val), null, 2) }
    catch { return val }
  }
  return JSON.stringify(val, null, 2)
}

/** 从 requestBody 取最新用户输入——支持 messages 数组和 input 数组两种格式 */
function userInput(): string {
  const body = parsedBody.value
  if (!body) return ''
  // messages 格式（OpenAI Chat）
  const msgs = body.messages as Record<string, unknown>[] | undefined
  if (msgs) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        const c = msgs[i].content
        return typeof c === 'string' ? c : JSON.stringify(c)
      }
    }
  }
  // input 格式（OpenAI Responses / Anthropic）
  const input = body.input
  if (typeof input === 'string') return input
  if (Array.isArray(input)) {
    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i] as Record<string, unknown>
      if (item.role === 'user' || item.type === 'message') {
        const c = item.content
        if (typeof c === 'string') return c
        if (Array.isArray(c)) {
          for (const block of c as Record<string, unknown>[]) {
            if (typeof block.text === 'string') return block.text
          }
        }
      }
    }
  }
  return ''
}

/** 从 requestBody 提取 tool_result——仅最新一轮（和旧版 extractUserRequest 一致）。
 *  找最后一条 user 消息，往前扫 tool 消息，遇到 assistant 就停（本轮边界）。 */
function extractToolResults(): { tool_call_id: string; content: string; tool_name?: string }[] {
  const body = parsedBody.value
  if (!body) return []
  const findTc = (id: string) => toolCalls.value.find(t => t.tool_call_id === id)
  const msgs = body.messages as Record<string, unknown>[] | undefined
  if (!msgs) return []

  let lastUserIdx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') { lastUserIdx = i; break }
  }
  if (lastUserIdx === -1) return []

  const toolResults: { tool_call_id: string; content: string; tool_name?: string }[] = []
  for (let i = lastUserIdx - 1; i >= 0; i--) {
    const msg = msgs[i]
    if (msg.role === 'assistant') break
    if (isOpenAI.value && msg.role === 'tool' && msg.tool_call_id) {
      const tc = findTc(String(msg.tool_call_id))
      toolResults.unshift({ tool_call_id: String(msg.tool_call_id), content: fmtJson(msg.content), tool_name: tc?.tool_name })
    }
    if (isAnthropic.value && Array.isArray(msg.content)) {
      for (const block of msg.content as Record<string, unknown>[]) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const tc = findTc(String(block.tool_use_id))
          toolResults.unshift({ tool_call_id: String(block.tool_use_id), content: fmtJson(block.content), tool_name: tc?.tool_name })
        }
      }
    }
  }
  return toolResults
}

function getToolArgs(toolCallId: string): string | undefined {
  return toolCalls.value.find(t => t.tool_call_id === toolCallId)?.arguments
}
function getToolResult(toolCallId: string): string | undefined {
  return toolCalls.value.find(t => t.tool_call_id === toolCallId)?.result
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
  const ui = userInput()
  if (ui) out += `## 用户请求\n\n${ui}\n\n`
  if (r.responseContent) out += `## 响应\n\n${JSON.stringify(r.responseContent, null, 2)}\n\n`
  copyText(out)
}
</script>

<template>
  <div class="detail-page">
    <!-- 导航栏 -->
    <div class="nav-bar">
      <button class="btn-back" @click="router.push({ name: 'list' })">&larr; 返回列表</button>
      <button v-if="record" class="btn-export" @click="doExport">导出</button>
      <div class="detail-nav">
        <button class="btn-nav" :disabled="!store.total" @click="navigate(1)">&uarr; 上一条</button>
        <span class="detail-nav-pos">{{ store.items.findIndex(r => r.id === id) + 1 }} / {{ store.total }}</span>
        <button class="btn-nav" :disabled="!store.total" @click="navigate(-1)">&darr; 下一条</button>
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
        <span v-if="record.error" style="color:var(--error);font-weight:600;">错误: {{ record.error }}</span>
        <span v-if="isStreaming" style="color:var(--accent);font-weight:600;">● 传输中…</span>
      </div>

      <TokenBreakdown :record="record" />

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

      <!-- 请求体 -->
      <details class="details-card" v-if="record.requestBody">
        <summary>请求体</summary>
        <JsonViewer :value="fmtJson(record.requestBody)" />
      </details>

      <!-- 用户请求 -->
      <div v-if="userInput() || extractToolResults().length" class="user-request-card">
        <span class="section-label label-user-request">用户请求</span>
        <div v-if="userInput()" class="user-text">{{ userInput() }}</div>

        <div v-if="extractToolResults().length" class="tool-results-section">
          <div class="tool-results-label">工具调用结果 ({{ extractToolResults().length }})</div>
          <div v-for="tr in extractToolResults()" :key="tr.tool_call_id" class="tool-result-item">
            <div class="tool-result-id">
              <span>{{ tr.tool_call_id }}</span>
              <span v-if="tr.tool_name" class="tool-tip-badge">{{ tr.tool_name }}</span>
              <div v-if="getToolArgs(tr.tool_call_id)" class="tool-tip-popup">
                <span class="tool-tip-name">{{ tr.tool_name || 'tool' }}</span>
                <JsonViewer :value="getToolArgs(tr.tool_call_id)!" />
              </div>
            </div>
            <JsonViewer :value="tr.content" />
          </div>
        </div>
      </div>

      <!-- 响应内容 -->
      <div v-if="isStreaming && streamText" class="card streaming-card">
        <span class="section-label label-streaming">实时接收中…</span>
        <StreamLive :text="streamText" />
      </div>

      <div v-else-if="record.responseContent && !isStreaming">
        <!-- OpenAI Chat -->
        <template v-if="isOpenAI && (record.responseContent as any)?.choices">
          <div class="card" v-if="(record.responseContent as any).model">
            <div class="card-title">模型: <span class="kv kv-model">{{ (record.responseContent as any).model }}</span></div>
          </div>
          <template v-for="choice in (record.responseContent as any).choices" :key="choice.index">
            <details v-if="choice.message?.reasoning_content" class="details-card reasoning-card" open>
              <summary>
                <span class="section-label label-reasoning">推理过程</span>
              </summary>
              <div class="reasoning-content"><JsonViewer :value="choice.message.reasoning_content" lang="plaintext" /></div>
            </details>
            <div v-if="choice.message?.content" class="card">
              <span class="section-label label-content">回答</span>
              <div class="content-text">{{ choice.message.content }}</div>
            </div>
            <ToolCallCard
              v-for="tc in (choice.message?.tool_calls ?? [])"
              :key="tc.index"
              :tool-call-id="tc.id"
              :tool-name="tc.function?.name"
              :tool-args="getToolArgs(tc.id) ?? tc.function?.arguments"
              :result="getToolResult(tc.id)"
              :request-id="record.id"
              side="request"
            />
            <div v-if="choice.finish_reason" class="finish-reason">
              结束原因: <span :class="`kv kv-finish kv-finish-${choice.finish_reason}`">{{ choice.finish_reason }}</span>
            </div>
          </template>
        </template>

        <!-- OpenAI Responses -->
        <template v-else-if="(record.responseContent as any)?.object === 'response'">
          <div class="card" v-if="(record.responseContent as any).model">
            <div class="card-title">模型: <span class="kv kv-model">{{ (record.responseContent as any).model }}</span></div>
          </div>
          <details v-if="(record.responseContent as any).reasoning_text" class="details-card reasoning-card" open>
            <summary><span class="section-label label-reasoning">推理过程</span></summary>
            <div class="reasoning-content"><JsonViewer :value="(record.responseContent as any).reasoning_text" lang="plaintext" /></div>
          </details>
          <div v-if="(record.responseContent as any).output_text" class="card">
            <span class="section-label label-content">回答</span>
            <div class="content-text">{{ (record.responseContent as any).output_text }}</div>
          </div>
          <!-- Responses API tool_calls: 从 output[] 提取 function_call -->
          <template v-for="(item, oi) in (record.responseContent as any).output ?? []" :key="oi">
            <ToolCallCard
              v-if="item?.type === 'function_call'"
              :tool-call-id="item.id || item.call_id"
              :tool-name="item.name"
              :tool-args="getToolArgs(item.id||item.call_id) ?? item.arguments"
              :result="getToolResult(item.id||item.call_id)"
              :request-id="record.id"
              side="request"
            />
          </template>
        </template>

        <!-- Anthropic -->
        <template v-else-if="isAnthropic">
          <div class="card" v-if="(record.responseContent as any).model">
            <div class="card-title">模型: <span class="kv kv-model">{{ (record.responseContent as any).model }}</span></div>
          </div>
          <div class="content-blocks">
            <template v-for="block in (record.responseContent as any).content" :key="block.index">
              <div v-if="block.type === 'text'" class="anthropic-block text">
                <div class="block-header">文本块 #{{ block.index }}</div>
                <div class="block-body"><div class="content-text">{{ block.text }}</div></div>
              </div>
              <div v-else-if="block.type === 'thinking'" class="anthropic-block thinking">
                <div class="block-header">思考块 #{{ block.index }}</div>
                <div class="block-body"><JsonViewer :value="block.thinking" lang="plaintext" /></div>
              </div>
              <ToolCallCard
                v-else-if="block.type === 'tool_use'"
                :tool-call-id="block.id"
                :tool-name="block.name"
                :tool-args="getToolArgs(block.id) ?? fmtJson(block.input)"
                :result="getToolResult(block.id)"
                :request-id="record.id"
                side="request"
              />
            </template>
          </div>
        </template>
      </div>

      <!-- 响应头 -->
      <HeadersViewer title="响应头" :headers="record.responseHeaders ?? {}" />

      <!-- 响应体（原始 / 合并双 tab） -->
      <details class="details-card" v-if="record.responseBody">
        <summary>响应体</summary>
        <div class="rb-tabs">
          <button class="rb-tab" :class="{ active: respBodyTab === 'raw' }" @click="respBodyTab = 'raw'">原始</button>
          <button class="rb-tab" :class="{ active: respBodyTab === 'merged' }" @click="respBodyTab = 'merged'">合并</button>
        </div>
        <div class="rb-pane" v-show="respBodyTab === 'raw'">
          <JsonViewer :value="record.responseBody" :lang="record.responseBody.startsWith('{') ? 'json' : 'plaintext'" />
        </div>
        <div class="rb-pane" v-show="respBodyTab === 'merged'">
          <JsonViewer :value="mergedContentText" lang="json" />
        </div>
      </details>

    </template>
  </div>
</template>

<style scoped>
.detail-page { max-width: 1280px; margin: 0 auto; padding: 28px 24px; }

/* Nav */
.nav-bar { display: flex; align-items: center; gap: 6px; margin-bottom: 16px; flex-wrap: wrap; }

.btn-back {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--bg-card); color: var(--accent); border: 1px solid var(--border);
  padding: 8px 16px; border-radius: var(--radius-sm); cursor: pointer;
  font-size: 0.84rem; font-weight: 500; box-shadow: var(--shadow-sm); transition: all .15s;
}
.btn-back:hover { background: var(--accent); color: #fff; border-color: var(--accent); }

.btn-export {
  background: var(--bg-card); color: var(--text-secondary); border: 1px solid var(--border);
  padding: 8px 14px; border-radius: var(--radius-sm); cursor: pointer;
  font-size: 0.82rem; font-weight: 500; box-shadow: var(--shadow-sm); transition: all .15s;
}
.btn-export:hover { background: var(--success); color: #fff; border-color: var(--success); }

.detail-nav { display: inline-flex; align-items: center; gap: 6px; margin-left: 12px; }

.btn-nav {
  display: inline-flex; align-items: center; gap: 4px;
  background: var(--bg-card); color: var(--text-secondary); border: 1px solid var(--border);
  padding: 8px 14px; border-radius: var(--radius-sm); cursor: pointer;
  font-size: 0.82rem; font-weight: 500; box-shadow: var(--shadow-sm); transition: all .15s;
}
.btn-nav:hover:not(:disabled) { background: var(--accent); color: #fff; border-color: var(--accent); }
.btn-nav:disabled { opacity: .35; cursor: default; }

.detail-nav-pos { font-size: 0.78rem; color: var(--text-muted); font-family: var(--font-mono); padding: 0 4px; min-width: 60px; text-align: center; }

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
.card + .card { margin-top: -8px; }
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
.reasoning-card + .reasoning-card { margin-top: -8px; }
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

/* User card */
.user-request-card {
  background: var(--bg-card); border-radius: var(--radius); box-shadow: var(--shadow-sm);
  overflow: hidden; margin-bottom: 12px; border-left: 4px solid #ab47bc; padding: 18px 20px;
}
.user-text {
  white-space: pre-wrap; word-break: break-word;
  min-height: 40px; font-size: 0.9rem;
}
.tool-results-section { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 10px; }
.tool-results-label {
  font-size: 0.75rem; font-weight: 600; color: #7b1fa2;
  text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px;
}
.tool-result-item {
  background: var(--bg-inset); border-radius: var(--radius-sm); overflow: hidden; margin-bottom: 8px;
}
.tool-result-item:last-child { margin-bottom: 0; }
.tool-result-id {
  padding: 6px 12px; font-family: var(--font-mono); font-size: 0.7rem;
  color: var(--text-muted); background: #ede7f6; border-bottom: 1px solid #d1c4e9;
  position: relative; display: flex; align-items: center; gap: 8px;
}
.tool-result-id:hover .tool-tip-popup,
.tool-tip-popup:hover { display: block; }
.tool-tip-badge {
  font-family: var(--font-sans); font-size: 0.65rem; font-weight: 600;
  color: var(--accent); background: #eef2ff; padding: 1px 8px;
  border-radius: 10px; border: 1px solid #c7d2fe;
}
.tool-tip-popup {
  display: none; position: absolute; top: 100%; left: 0; z-index: 100;
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: var(--shadow-lg);
  padding: 12px 16px; min-width: 320px; max-width: 480px;
}
.tool-tip-popup :deep(.monaco-box) { min-width: 300px; min-height: 60px; max-height: 300px; }
.tool-tip-name {
  display: inline-block; font-family: var(--font-mono); font-size: 0.78rem;
  font-weight: 700; color: #4338ca; background: #eef2ff; padding: 4px 10px;
  border-radius: 5px; border: 1px solid #c7d2fe; margin-bottom: 8px;
}

/* Section labels */
.label-reasoning { background: #e3f2fd; color: #1565c0; }
.label-content { background: #e8f5e9; color: #2e7d32; }
.label-tool { background: #eef2ff; color: #4338ca; }
.label-streaming { background: #e0e7ff; color: #3730a3; animation: pulse 1.5s ease-in-out infinite; }
.label-user-request { background: #f3e5f5; color: #7b1fa2; }

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
</style>
