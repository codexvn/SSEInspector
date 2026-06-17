<script setup lang="ts">
import JsonViewer from './JsonViewer.vue'

const props = withDefaults(defineProps<{
  title?: string
  value: unknown
}>(), {
  title: '原始 JSON',
})

function format(value: unknown): string {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2) }
    catch { return value }
  }
  return JSON.stringify(value, null, 2)
}
</script>

<template>
  <div class="raw-json-card">
    <div class="raw-json-title">{{ title }}</div>
    <JsonViewer :value="format(props.value)" lang="json" />
  </div>
</template>

<style scoped>
.raw-json-card {
  background: var(--bg-card);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  margin-bottom: 12px;
  border-left: 4px solid #78909c;
}

.raw-json-title {
  padding: 10px 16px;
  background: var(--bg-inset);
  border-bottom: 1px solid var(--border);
  font-size: 0.75rem;
  font-weight: 700;
  color: #546e7a;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
</style>
