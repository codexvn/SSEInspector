<script setup lang="ts">
import { ref } from 'vue'
import { fetchToolCallPair } from '../api'
import JsonViewer from './JsonViewer.vue'

const props = defineProps<{
  toolCallId: string
  toolName: string
  toolArgs?: string
  result?: string
  requestId: string
  side: 'request' | 'result'
}>()

const hoverData = ref<string | null>(null)
const loading = ref(false)

async function onEnter() {
  if (hoverData.value || loading.value) return
  loading.value = true
  try {
    const pair = await fetchToolCallPair(props.toolName, props.toolCallId)
    hoverData.value = (props.side === 'request' ? pair.prevResult : pair.nextRequest) ?? null
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
  <div class="tool-call" @mouseenter="onEnter" @mouseleave="onLeave">
    <div class="tool-header">
      <span class="tool-name">{{ toolName }}</span>
      <span class="tool-id">{{ toolCallId }}</span>
      <div v-if="hoverData" class="tool-tip-popup">
        <div class="tool-tip-name">{{ toolName }}</div>
        <JsonViewer :value="side === 'request' ? hoverData : fmtArgs(hoverData)" />
      </div>
    </div>
    <pre v-if="toolArgs" class="args-pre">{{ fmtArgs(toolArgs) }}</pre>
  </div>
</template>

<style scoped>
.tool-call {
  background: var(--bg-card); border-radius: var(--radius); box-shadow: var(--shadow-sm);
  overflow: hidden; margin-bottom: 10px;
}
.tool-call + .tool-call { margin-top: -6px; }

.tool-header {
  padding: 10px 16px; background: #eef2ff; border-bottom: 1px solid var(--border);
  font-weight: 600; color: #4338ca; font-family: var(--font-mono);
  font-size: 0.83rem; position: relative; display: flex; align-items: center; gap: 8px;
}
.tool-header .tool-id {
  color: var(--text-muted); font-size: 0.73rem; margin-left: 8px; font-weight: normal;
}
.tool-header:hover .tool-tip-popup,
.tool-tip-popup:hover { display: block; }

.tool-name {
  background: #e0e7ff; color: #3730a3; padding: 3px 8px; border-radius: 5px;
  font-weight: 700; font-size: 0.85rem; border: 1px solid #c7d2fe;
}

.args-pre {
  padding: 14px 16px; font-family: var(--font-mono); font-size: 0.8rem;
  line-height: 1.55; overflow-x: auto; max-height: 300px; overflow-y: auto;
  color: var(--text-primary);
}

.tool-tip-popup {
  display: none; position: absolute; top: 100%; left: 0; z-index: 100;
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: var(--shadow-lg);
  padding: 12px 16px; min-width: 320px; max-width: 480px;
}
.tool-tip-name {
  display: inline-block; font-family: var(--font-mono); font-size: 0.78rem;
  font-weight: 700; color: #4338ca; background: #eef2ff; padding: 4px 10px;
  border-radius: 5px; border: 1px solid #c7d2fe; margin-bottom: 8px;
}
.tool-tip-none { font-size: 0.75rem; color: var(--text-muted); font-style: italic; }
</style>
