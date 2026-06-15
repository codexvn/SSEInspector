<script setup lang="ts">
import JsonViewer from './JsonViewer.vue'

defineProps<{ headers: Record<string, string>; title: string }>()

function fmt(v: Record<string, string>): string {
  return JSON.stringify(v, null, 2)
}
</script>

<template>
  <details v-if="Object.keys(headers).length > 0" class="headers-box">
    <summary>{{ title }}</summary>
    <JsonViewer :value="fmt(headers)" />
  </details>
</template>

<style scoped>
.headers-box {
  background: var(--bg-card); border-radius: 8px; padding: 10px 14px;
  margin-bottom: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.04);
}
summary { cursor: pointer; font-weight: 600; font-size: 0.85rem; padding: 4px 0; }
</style>
