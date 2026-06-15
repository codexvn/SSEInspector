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
  background: var(--bg-card); border-radius: var(--radius);
  box-shadow: var(--shadow-sm); overflow: hidden; margin-bottom: 12px;
  padding: 0;
}
.headers-box summary {
  cursor: pointer; padding: 12px 18px; font-size: 0.82rem;
  font-weight: 600; color: var(--text-secondary); user-select: none;
  position: relative;
}
</style>
