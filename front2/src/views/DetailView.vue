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
import Pagination from '../components/Pagination.vue'

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

// 监听 store SSE 更新当前记录的 streamText
const streamText = computed(() => {
  const summary = store.items.find(r => r.id === id.value)
  return summary?.streamText
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = await store.loadDetail(id.value)
    if (!r) { error.value = '请求未找到'; return }
    record.value = r
    // 加载工具调用
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

onMounted(load)
watch(id, load)

// 键盘导航
function onKeydown(e: KeyboardEvent) {
  if (e.target !== document.body) return
  if (e.key === 'ArrowLeft') navigate(1)
  if (e.key === 'ArrowRight') navigate(-1)
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))

function navigate(delta: number) {
  const idx = store.items.findIndex(r => r.id === id.value)
  if (idx < 0) return
  const next = store.items[idx + delta]
  if (next) router.push({ name: 'detail', params: { id: next.id } })
}

// ---- 内容渲染 helpers ----
function fmtJson(val: unknown): string {
  if (typeof val === 'string') {
    try { return JSON.stringify(JSON.parse(val), null, 2) }
    catch { return val }
  }
  return JSON.stringify(val, null, 2)
}

// 从 requestBody 提取用户输入
function userInput(): string {
  const body = record.value?.requestBody as Record<string, unknown> | undefined
  const msgs = body?.messages as Record<string, unknown>[] | undefined
  if (!msgs) return ''
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      const c = msgs[i].content
      return typeof c === 'string' ? c : JSON.stringify(c)
    }
  }
  return ''
}

// 提取 tool results（来自 requestBody 的 tool 消息）
function extractToolResults(): { tool_call_id: string; content: string }[] {
  const body = record.value?.requestBody as Record<string, unknown> | undefined
  const msgs = body?.messages as Record<string, unknown>[] | undefined
  if (!msgs) return []
  const results: { tool_call_id: string; content: string }[] = []
  for (const msg of msgs) {
    if (isOpenAI.value && msg.role === 'tool' && msg.tool_call_id) {
      results.push({ tool_call_id: String(msg.tool_call_id), content: fmtJson(msg.content) })
    }
    if (isAnthropic.value && Array.isArray(msg.content)) {
      for (const block of msg.content as Record<string, unknown>[]) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          results.push({ tool_call_id: String(block.tool_use_id), content: fmtJson(block.content) })
        }
      }
    }
  }
  return results
}

// 获取 tool call 的 arguments/result 映射
function getToolArgs(toolCallId: string): string | undefined {
  return toolCalls.value.find(t => t.tool_call_id === toolCallId)?.arguments
}
function getToolResult(toolCallId: string): string | undefined {
  return toolCalls.value.find(t => t.tool_call_id === toolCallId)?.result
}

// cURL 生成
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
    <!-- 顶栏导航 -->
    <div class="nav-bar">
      <div class="nav-left">
        <button @click="router.push({ name: 'list' })">&larr; 返回列表</button>
        <button :disabled="!store.items.length" @click="navigate(1)">上一条</button>
        <button :disabled="!store.items.length" @click="navigate(-1)">下一条</button>
        <button v-if="record" @click="doExport">导出</button>
      </div>
      <div v-if="store.items.length" class="nav-pos">
        {{ store.items.findIndex(r => r.id === id) + 1 }} / {{ store.items.length }}
      </div>
    </div>

    <!-- 加载 / 错误状态 -->
    <div v-if="loading && !record" class="status-msg">加载中…</div>
    <div v-else-if="error" class="status-msg error">{{ error }}</div>

    <template v-if="record">
      <!-- Meta 栏 -->
      <div class="meta-bar">
        <span>ID: {{ record.id }}</span>
        <span>时间: {{ new Date(record.timestamp).toLocaleString('zh-CN') }}</span>
        <span>API: <span :class="`badge badge-${isOpenAI ? 'openai' : 'anthropic'}`">{{ isOpenAI ? 'OpenAI' : 'Anthropic' }}</span></span>
        <span>流式: {{ record.streaming ? '是' : '否' }}</span>
        <span>耗时: {{ isStreaming ? '…' : record.durationMs + 'ms' }}</span>
        <span>状态: <span :class="`badge ${record.responseStatus < 300 ? 'badge-ok' : record.responseStatus < 500 ? 'badge-warn' : 'badge-err'}`">{{ record.responseStatus }}</span></span>
        <span v-if="record.error" class="meta-error">错误: {{ record.error }}</span>
        <span v-if="isStreaming" class="meta-streaming">● 传输中…</span>
      </div>

      <!-- Token -->
      <TokenBreakdown :record="record" />

      <!-- 请求地址 -->
      <div class="card">
        <div class="card-title">请求地址</div>
        <div class="url-row">
          <code>{{ record.method }} {{ record.path }}</code>
          <button class="mini-btn" @click="copyText(buildCurl(record.path))">curl</button>
        </div>
        <div class="url-row" style="margin-top:6px">
          <code>{{ record.method }} {{ record.upstreamUrl }}</code>
          <button class="mini-btn" @click="copyText(buildCurl(record.upstreamUrl))">curl</button>
        </div>
      </div>

      <!-- 请求头 / 响应头 -->
      <HeadersViewer :headers="record.requestHeaders" title="请求头" />
      <HeadersViewer :headers="record.responseHeaders ?? {}" title="响应头" />

      <!-- 请求体 -->
      <details v-if="record.requestBody" class="details-box">
        <summary>请求体</summary>
        <JsonViewer :value="fmtJson(record.requestBody)" />
      </details>

      <!-- 用户请求 -->
      <div v-if="userInput()" class="card user-card">
        <div class="card-title">用户请求</div>
        <div class="user-text">{{ userInput() }}</div>

        <!-- Tool result -->
        <div v-for="tr in extractToolResults()" :key="tr.tool_call_id" class="tool-result">
          <div class="tool-result-id">
            <span class="tool-result-id-text">{{ tr.tool_call_id }}</span>
            <span v-if="getToolArgs(tr.tool_call_id)" class="badge badge-anthropic" style="font-size:0.7rem">{{ toolCalls.find(t => t.tool_call_id === tr.tool_call_id)?.tool_name }}</span>
          </div>
          <JsonViewer :value="tr.content" />
        </div>
      </div>

      <!-- 响应内容 -->
      <div v-if="isStreaming && streamText" class="card">
        <StreamLive :text="streamText" />
      </div>

      <div v-else-if="record.responseContent && !isStreaming" class="card">
        <div class="card-title">
          模型: <span class="kv-model">{{ (record.responseContent as any)?.model ?? 'unknown' }}</span>
        </div>

        <!-- OpenAI Chat -->
        <template v-if="isOpenAI && (record.responseContent as any)?.choices">
          <template v-for="choice in (record.responseContent as any).choices" :key="choice.index">
            <details v-if="choice.message?.reasoning_content" class="details-box" open>
              <summary>推理过程</summary>
              <div class="reasoning-text">{{ choice.message.reasoning_content }}</div>
            </details>
            <div v-if="choice.message?.content" class="content-text">{{ choice.message.content }}</div>
            <ToolCallCard
              v-for="tc in (choice.message?.tool_calls ?? [])"
              :key="tc.index"
              :tool-call-id="tc.id"
              :tool-name="tc.function?.name"
              :arguments="getToolArgs(tc.id) ?? tc.function?.arguments"
              :result="getToolResult(tc.id)"
              :request-id="record.id"
              side="request"
            />
            <div v-if="choice.finish_reason" class="finish-reason">
              结束原因: <span :class="`kv kv-finish-${choice.finish_reason}`">{{ choice.finish_reason }}</span>
            </div>
          </template>
        </template>

        <!-- OpenAI Responses -->
        <template v-else-if="(record.responseContent as any)?.object === 'response'">
          <details v-if="(record.responseContent as any).reasoning_text" class="details-box" open>
            <summary>推理过程</summary>
            <div class="reasoning-text">{{ (record.responseContent as any).reasoning_text }}</div>
          </details>
          <div v-if="(record.responseContent as any).output_text" class="content-text">
            {{ (record.responseContent as any).output_text }}
          </div>
        </template>

        <!-- Anthropic -->
        <template v-else-if="isAnthropic">
          <template v-for="block in (record.responseContent as any).content" :key="block.index">
            <div v-if="block.type === 'text'" class="content-text">{{ block.text }}</div>
            <details v-else-if="block.type === 'thinking'" class="details-box" open>
              <summary>思考块 #{{ block.index }}</summary>
              <div class="reasoning-text">{{ block.thinking }}</div>
            </details>
            <ToolCallCard
              v-else-if="block.type === 'tool_use'"
              :tool-call-id="block.id"
              :tool-name="block.name"
              :arguments="getToolArgs(block.id) ?? fmtJson(block.input)"
              :result="getToolResult(block.id)"
              :request-id="record.id"
              side="request"
            />
          </template>
        </template>
      </div>

      <!-- 响应体 -->
      <details v-if="record.responseBody" class="details-box">
        <summary>响应体</summary>
        <JsonViewer :value="record.responseBody" :lang="record.responseBody.startsWith('{') ? 'json' : 'plaintext'" />
      </details>

      <Pagination />
    </template>
  </div>
</template>

<style scoped>
.detail-page { max-width: 1000px; margin: 0 auto; padding: 16px; }

.nav-bar {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 12px; gap: 8px; flex-wrap: wrap;
}
.nav-left { display: flex; gap: 6px; }
.nav-left button {
  background: var(--bg-card); border: 1px solid #d0d5dd; color: var(--text);
}
.nav-left button:hover:not(:disabled) { background: #e8ecf1; }
.nav-pos { font-size: 0.85rem; color: var(--text-secondary); }

.meta-bar {
  display: flex; gap: 16px; flex-wrap: wrap; font-size: 0.8rem;
  color: var(--text-secondary); padding: 8px 0; margin-bottom: 8px;
}
.meta-error { color: var(--error); font-weight: 600; }
.meta-streaming { color: var(--accent); font-weight: 600; }

.card {
  background: var(--bg-card); border-radius: 8px; padding: 14px;
  margin-bottom: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.06);
}
.card-title { font-weight: 600; font-size: 0.9rem; margin-bottom: 6px; }

.url-row { display: flex; align-items: center; gap: 8px; }
.url-row code { font-size: 0.8rem; word-break: break-all; color: var(--text-secondary); }
.mini-btn {
  background: #e0e7ff; color: var(--accent); font-size: 0.75rem;
  padding: 2px 8px; flex-shrink: 0;
}

.details-box {
  background: var(--bg-card); border-radius: 8px; padding: 10px 14px;
  margin-bottom: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.04);
}
.details-box summary { cursor: pointer; font-weight: 600; font-size: 0.85rem; padding: 4px 0; }

.user-card { }
.user-text {
  white-space: pre-wrap; word-break: break-word;
  background: #f9fafb; padding: 10px; border-radius: 6px;
  margin-bottom: 10px; font-size: 0.9rem;
}

.tool-result { margin-top: 8px; }
.tool-result-id {
  display: flex; gap: 8px; align-items: center; margin-bottom: 4px;
}
.tool-result-id-text { font-size: 0.75rem; color: var(--text-secondary); font-family: monospace; }

.content-text {
  white-space: pre-wrap; word-break: break-word;
  padding: 10px 0; font-size: 0.9rem; line-height: 1.6;
}
.reasoning-text {
  white-space: pre-wrap; word-break: break-word;
  background: #f3e8ff; padding: 10px; border-radius: 6px;
  font-size: 0.85rem; color: #6b21a8; margin-top: 6px;
}
.finish-reason { font-size: 0.8rem; color: var(--text-secondary); margin-top: 8px; }

.kv-model { background: #e0e7ff; padding: 1px 6px; border-radius: 4px; font-size: 0.85rem; }
.kv { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 0.8rem; }
.kv-finish-stop { background: #dcfce7; color: #16a34a; }
.kv-finish-length, .kv-finish-tool_calls, .kv-finish-end_turn { background: #dbeafe; color: #2563eb; }

.status-msg { text-align: center; padding: 40px 0; color: var(--text-secondary); }
.status-msg.error { color: var(--error); }
</style>
