<script setup lang="ts">
import { ref } from 'vue'
import { fetchToolCallPair } from '../api'
import JsonViewer from './JsonViewer.vue'

const props = defineProps<{
  toolCallId: string
  toolName?: string
  result?: string
}>()

const hoverData = ref<string | null>(null)
const loading = ref(false)

async function onEnter() {
  if (!props.toolName || hoverData.value || loading.value) return
  loading.value = true
  try {
    const pair = await fetchToolCallPair(props.toolName, props.toolCallId)
    hoverData.value = pair.nextRequest ?? null
  } catch {
    hoverData.value = null
  } finally {
    loading.value = false
  }
}

function onLeave() {
  hoverData.value = null
}
</script>

<template>
  <div class="tool-result-card" @mouseenter="onEnter" @mouseleave="onLeave">
    <div class="tool-result-header">
      <span class="tool-result-title">工具结果</span>
      <span v-if="toolName" class="tool-name">{{ toolName }}</span>
      <span class="tool-id">{{ toolCallId }}</span>
      <div v-if="hoverData" class="tool-tip-popup">
        <div class="tool-tip-name">{{ toolName || 'tool' }}</div>
        <JsonViewer :value="hoverData" />
      </div>
    </div>
    <JsonViewer :value="result ?? ''" />
  </div>
</template>

<style scoped>
.tool-result-card {
  background: var(--bg-card);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  margin-bottom: 12px;
  border-left: 4px solid #ab47bc;
}

.tool-result-header {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: #ede7f6;
  border-bottom: 1px solid #d1c4e9;
}

.tool-result-title,
.tool-name {
  font-size: 0.75rem;
  font-weight: 700;
  color: #7b1fa2;
}

.tool-name {
  font-family: var(--font-mono);
}

.tool-id {
  font-family: var(--font-mono);
  color: var(--text-muted);
  font-size: 0.72rem;
}

.tool-result-header:hover .tool-tip-popup,
.tool-tip-popup:hover {
  display: block;
}

.tool-tip-popup {
  display: none;
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 100;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  padding: 12px 16px;
  min-width: 320px;
  max-width: 480px;
}

.tool-tip-name {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  font-weight: 700;
  color: #4338ca;
  background: #eef2ff;
  padding: 4px 10px;
  border-radius: 5px;
  border: 1px solid #c7d2fe;
  margin-bottom: 8px;
}
</style>
