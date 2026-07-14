<script setup lang="ts">
import { computed } from 'vue'
import type { RequestContextAnalysis, ContextCompositionKind } from '../context-composition'

const props = defineProps<{ analysis: RequestContextAnalysis }>()

const LABELS: Record<ContextCompositionKind, string> = {
  instructions: 'Instructions',
  user: 'User',
  assistant: 'Assistant',
  tool_definitions: '工具定义',
  tool_interactions: '工具交互',
  attachments: '附件',
  other: '其他配置',
}
const visibleParts = computed(() => props.analysis.parts.filter(part => part.bytes > 0))

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}
</script>

<template>
  <div class="context-card">
    <div class="context-header">
      <span class="context-title">上下文组成</span>
      <span class="context-total">{{ formatBytes(analysis.totalBytes) }}</span>
    </div>
    <div class="context-bar">
      <span
        v-for="part in visibleParts"
        :key="part.kind"
        class="context-segment"
        :class="`segment-${part.kind}`"
        :style="{ width: `${part.ratio}%` }"
        :title="`${LABELS[part.kind]}: ${formatBytes(part.bytes)} (${part.ratio}%)`"
      />
    </div>
    <div class="context-legend">
      <div v-for="part in visibleParts" :key="part.kind" class="context-item">
        <span class="context-dot" :class="`segment-${part.kind}`" />
        <span>{{ LABELS[part.kind] }}</span>
        <code>{{ formatBytes(part.bytes) }} · {{ part.ratio }}%</code>
      </div>
    </div>
    <div class="context-note">按 UTF-8 字节估算上下文体积，不代表模型 token。</div>
  </div>
</template>

<style scoped>
.context-card { background: var(--bg-card); border-radius: var(--radius); padding: 16px 18px; margin-bottom: 12px; box-shadow: var(--shadow-sm); }
.context-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.context-title { font-size: .82rem; font-weight: 650; color: var(--text-primary); }
.context-total { font: .76rem var(--font-mono); color: var(--text-secondary); }
.context-bar { display: flex; height: 10px; overflow: hidden; border-radius: 6px; background: var(--border); }
.context-segment { min-width: 2px; height: 100%; }
.context-legend { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 12px; }
.context-item { display: flex; align-items: center; gap: 6px; font-size: .76rem; color: var(--text-secondary); }
.context-item code { color: var(--text-muted); }
.context-dot { width: 8px; height: 8px; border-radius: 50%; }
.context-note { margin-top: 10px; font-size: .7rem; color: var(--text-muted); }
.segment-instructions { background: #8b5cf6; }
.segment-user { background: #3b82f6; }
.segment-assistant { background: #10b981; }
.segment-tool_definitions { background: #f59e0b; }
.segment-tool_interactions { background: #ef4444; }
.segment-attachments { background: #06b6d4; }
.segment-other { background: #94a3b8; }
</style>
