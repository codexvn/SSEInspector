<script setup lang="ts">
import { ref } from 'vue'
import RawJsonCard from './RawJsonCard.vue'

const props = defineProps<{ tools?: unknown[] }>()
const openTools = ref(new Set<number>())

function toggle(index: number) {
  if (openTools.value.has(index)) openTools.value.delete(index)
  else openTools.value.add(index)
  openTools.value = new Set(openTools.value)
}

function toolName(tool: unknown): string {
  const t = tool as Record<string, unknown>
  return String(t.name ?? (t.function as Record<string, unknown> | undefined)?.name ?? `tool-${props.tools?.indexOf(tool) ?? 0}`)
}

function toolDescription(tool: unknown): string {
  const t = tool as Record<string, unknown>
  return String(t.description ?? (t.function as Record<string, unknown> | undefined)?.description ?? '')
}
</script>

<template>
  <div v-if="tools?.length" class="tools-list-card">
    <div class="tools-list-header">工具列表 · {{ tools.length }} 个</div>
    <div class="tools-list-body">
      <div v-for="(tool, index) in tools" :key="index" class="tool-row">
        <button class="tool-row-head" type="button" @click="toggle(index)">
          <span class="tool-name">{{ toolName(tool) }}</span>
          <span v-if="toolDescription(tool)" class="tool-desc">{{ toolDescription(tool) }}</span>
          <span class="tool-toggle">{{ openTools.has(index) ? '收起' : '展开' }}</span>
        </button>
        <RawJsonCard v-if="openTools.has(index)" title="工具 Schema" :value="tool" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.tools-list-card {
  background: var(--bg-card);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  margin-bottom: 12px;
  border-left: 4px solid #ef5350;
}

.tools-list-header {
  padding: 10px 16px;
  background: #fce4ec;
  border-bottom: 1px solid var(--border);
  color: #c62828;
  font-size: 0.75rem;
  font-weight: 700;
}

.tools-list-body {
  padding: 10px 12px;
}

.tool-row + .tool-row {
  margin-top: 8px;
}

.tool-row-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
}

.tool-name {
  font-family: var(--font-mono);
  font-weight: 700;
  color: #7b1fa2;
  flex-shrink: 0;
}

.tool-desc {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.tool-toggle {
  margin-left: auto;
  color: var(--accent);
  font-size: 0.72rem;
  flex-shrink: 0;
}
</style>
