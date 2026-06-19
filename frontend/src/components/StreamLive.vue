<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import type { ApiEndpoint } from '../types'
import TokenSpeed from './TokenSpeed.vue'

const props = defineProps<{
  text: string
  startTime?: number
  /** 响应格式，由上层依据 path/apiType 判定后传入 */
  endpoint: ApiEndpoint
  /** 模型名，透传给 TokenSpeed 供后端 tokenizer 路由 */
  model?: string
}>()
const preRef = ref<HTMLPreElement | null>(null)

let atBottom = true

watch(() => props.text, () => {
  nextTick(() => {
    if (!preRef.value) return
    if (atBottom) preRef.value.scrollTop = preRef.value.scrollHeight
  })
})

function onScroll() {
  if (!preRef.value) return
  atBottom = preRef.value.scrollTop + preRef.value.clientHeight >= preRef.value.scrollHeight - 20
}
</script>

<template>
  <div class="stream-card">
    <div class="stream-speed">
      <TokenSpeed :text="text" :start-time="startTime" :endpoint="endpoint" state="streaming" :model="model" />
    </div>
    <pre ref="preRef" @scroll="onScroll">{{ text }}</pre>
  </div>
</template>

<style scoped>
.stream-card { border-left: 4px solid var(--accent); }
.stream-speed {
  padding: 4px 10px; margin-bottom: 6px;
}
.stream-card pre {
  font-family: var(--font-mono); font-size: 0.8rem; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word; max-height: 500px;
  overflow-y: auto; color: var(--text-primary);
}
</style>
