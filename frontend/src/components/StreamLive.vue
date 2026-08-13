<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'

const props = defineProps<{
  text: string
}>()
const preRef = ref<HTMLPreElement | null>(null)

let atBottom = true
let renderedText = ''

watch(() => props.text, async (text) => {
  await nextTick()
  if (!preRef.value) return
  if (text.startsWith(renderedText)) {
    const suffix = text.slice(renderedText.length)
    if (suffix) preRef.value.append(document.createTextNode(suffix))
  } else {
    preRef.value.textContent = text
  }
  renderedText = text
  if (atBottom) preRef.value.scrollTop = preRef.value.scrollHeight
}, { immediate: true })

function onScroll() {
  if (!preRef.value) return
  atBottom = preRef.value.scrollTop + preRef.value.clientHeight >= preRef.value.scrollHeight - 20
}
</script>

<template>
  <div class="stream-card">
    <pre ref="preRef" @scroll="onScroll"></pre>
  </div>
</template>

<style scoped>
.stream-card { border-left: 4px solid var(--accent); }
.stream-card pre {
  font-family: var(--font-mono); font-size: 0.8rem; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word; max-height: 500px;
  min-height: 3em;
  overflow-y: auto; color: var(--text-primary);
}
</style>
