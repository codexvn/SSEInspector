<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'

const props = defineProps<{ text: string }>()
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
    <div class="stream-label">实时接收中…</div>
    <pre ref="preRef" @scroll="onScroll">{{ text }}</pre>
  </div>
</template>

<style scoped>
.stream-card {
  background: var(--bg-card); border-radius: 8px; padding: 14px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
}
.stream-label { color: var(--accent); font-weight: 600; margin-bottom: 6px; font-size: 0.85rem; }
pre {
  background: #1e1e1e; color: #d4d4d4; padding: 12px; border-radius: 6px;
  overflow: auto; max-height: 500px; font-size: 0.8rem; white-space: pre-wrap; word-break: break-all;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
}
</style>
