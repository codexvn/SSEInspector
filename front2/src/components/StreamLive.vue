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
    <span class="section-label" style="background:#e0e7ff;color:#3730a3;animation:pulse 1.5s ease-in-out infinite;">实时接收中…</span>
    <pre ref="preRef" @scroll="onScroll">{{ text }}</pre>
  </div>
</template>

<style scoped>
.stream-card { border-left: 4px solid var(--accent); }
.stream-card pre {
  font-family: var(--font-mono); font-size: 0.8rem; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word; max-height: 500px;
  overflow-y: auto; color: var(--text-primary);
}
</style>
