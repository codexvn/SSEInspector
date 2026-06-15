<script setup lang="ts">
import { ref } from 'vue'
import { fetchToolCallPair } from '../api'
import JsonViewer from './JsonViewer.vue'

const props = defineProps<{
  toolCallId: string
  toolName: string
  arguments?: string
  result?: string
  requestId: string
  /** hover 方向：'request' 当前是结果行悬停看请求，'result' 当前是请求行悬停看结果 */
  side: 'request' | 'result'
}>()

const hoverData = ref<string | null>(null)
const loading = ref(false)

async function onEnter() {
  if (hoverData.value || loading.value) return
  loading.value = true
  try {
    const pair = await fetchToolCallPair(props.toolName, props.toolCallId)
    hoverData.value = (props.side === 'request' ? pair.nextRequest : pair.prevResult) ?? null
  } catch { /* ignore */ }
  finally { loading.value = false }
}

function onLeave() {
  hoverData.value = null
}

function fmtArgs(args?: string): string {
  if (!args) return '(无参数)'
  try { return JSON.stringify(JSON.parse(args), null, 2) }
  catch { return args }
}
</script>

<template>
  <div class="tool-card" @mouseenter="onEnter" @mouseleave="onLeave">
    <div class="tool-header">
      <span class="tool-name">{{ toolName }}</span>
      <span class="tool-id">{{ toolCallId }}</span>
      <span v-if="loading" class="tool-loading">加载中…</span>
    </div>

    <!-- 主内容 -->
    <div class="tool-body">
      <div v-if="result" class="tool-section">
        <div class="section-label">结果</div>
        <JsonViewer :value="result" />
      </div>
      <div v-if="arguments" class="tool-section">
        <div class="section-label">参数</div>
        <JsonViewer :value="fmtArgs(arguments)" />
      </div>
    </div>

    <!-- Hover 浮层 -->
    <div v-if="hoverData" class="tool-hover">
      <div class="section-label">{{ side === 'request' ? '对应请求' : '对应结果' }}</div>
      <JsonViewer :value="side === 'request' ? fmtArgs(hoverData) : hoverData" />
    </div>
  </div>
</template>

<style scoped>
.tool-card {
  background: var(--bg-card); border: 1px solid #e5e7eb; border-radius: 8px;
  padding: 10px 14px; margin-bottom: 8px; position: relative;
}
.tool-header {
  display: flex; gap: 10px; align-items: center; margin-bottom: 8px;
}
.tool-name { font-weight: 700; color: var(--accent); }
.tool-id { font-size: 0.75rem; color: var(--text-secondary); font-family: monospace; }
.tool-loading { font-size: 0.75rem; color: var(--warn); }
.tool-body { display: flex; flex-direction: column; gap: 6px; }
.tool-section { }
.section-label { font-size: 0.75rem; font-weight: 600; color: var(--text-secondary); margin-bottom: 4px; text-transform: uppercase; }
.tool-hover {
  position: absolute; top: 100%; left: 0; right: 0; z-index: 10;
  background: #fffbeb; border: 1px solid #fcd34d; border-radius: 6px;
  padding: 8px 12px; margin-top: 2px; box-shadow: 0 4px 12px rgba(0,0,0,.1);
}
</style>
