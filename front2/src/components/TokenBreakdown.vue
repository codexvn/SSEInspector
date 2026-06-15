<script setup lang="ts">
import { computed } from 'vue'
import type { RecordedRequest } from '../types'

const props = defineProps<{ record: RecordedRequest }>()

const tb = computed(() => props.record.tokenBreakdown)
const hasData = computed(() => tb.value && (tb.value.messages > 0 || tb.value.tools > 0 || tb.value.systemPrompt > 0))

const parts = computed(() => {
  if (!tb.value) return []
  const t = tb.value
  return [
    { label: 'Messages', value: t.messages, css: 'msg' },
    { label: 'Tools', value: t.tools, css: 'tool' },
    { label: 'System', value: t.systemPrompt, css: 'sys' },
  ].filter(p => p.value > 0)
})

const total = computed(() => tb.value?.totalInput ?? 0)
</script>

<template>
  <div v-if="hasData" class="token-card">
    <div class="title">Token 用量 · 输入分解</div>
    <div class="bar-wrap">
      <div v-for="p in parts" :key="p.label"
        class="bar" :class="p.css"
        :style="{ width: Math.max(Math.round(p.value / total * 100), 1) + '%' }"
        :title="`${p.label}: ${p.value.toLocaleString()} tokens`"
      ></div>
    </div>
    <div class="legend">
      <div v-for="p in parts" :key="p.label" class="legend-item">
        <span class="dot" :class="p.css"></span>
        <span class="legend-label">{{ p.label }}</span>
        <span class="legend-val">{{ p.value.toLocaleString() }} ({{ Math.round(p.value / total * 100) }}%)</span>
      </div>
    </div>
    <div class="total-row">
      <span>输入合计（我们计算）</span><span>{{ total.toLocaleString() }}</span>
    </div>
    <div v-if="tb?.apiReportedInput" class="total-row api-row">
      <span>API 报告输入 (偏差 {{ total > 0 ? Math.round(Math.abs((tb.apiReportedInput ?? 0) - total) / Math.max(tb.apiReportedInput ?? 1, total) * 100) : 0 }}%)</span>
      <span>{{ tb.apiReportedInput.toLocaleString() }}</span>
    </div>
    <div v-if="tb?.cacheRead" class="total-row cache-row">
      <span>缓存命中 cache_read</span>
      <span>{{ tb.cacheRead.toLocaleString() }} (命中率 {{ tb.apiReportedInput ? (tb.cacheRead / tb.apiReportedInput * 100).toFixed(6) : '0' }}%)</span>
    </div>
    <div v-if="tb?.tokenizerSource" class="source">tokenizer: {{ tb.tokenizerSource }}</div>
  </div>
</template>

<style scoped>
.token-card {
  background: var(--bg-card); border-radius: var(--radius); padding: 18px 20px;
  margin-bottom: 12px; box-shadow: var(--shadow-sm);
}
.title {
  font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--text-secondary); font-weight: 600; margin-bottom: 8px;
}
.bar-wrap { display: flex; height: 10px; border-radius: 5px; overflow: hidden; margin-bottom: 10px; }
.bar { height: 100%; }
.bar.msg { background: #6366f1; }
.bar.tool { background: #f59e0b; }
.bar.sys { background: #22c55e; }
.legend { display: flex; gap: 20px; margin-bottom: 8px; flex-wrap: wrap; }
.legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.8rem; }
.dot { width: 10px; height: 10px; border-radius: 2px; }
.dot.msg { background: #6366f1; }
.dot.tool { background: #f59e0b; }
.dot.sys { background: #22c55e; }
.legend-label { color: var(--text-secondary); }
.legend-val { color: var(--text-secondary); margin-left: 4px; }
.total-row {
  display: flex; justify-content: space-between; font-size: 0.8rem;
  padding: 3px 0; border-top: 1px solid var(--border);
}
.api-row { color: var(--text-secondary); border-top: none; }
.cache-row { color: var(--text-muted); border-top: none; }
.source { font-size: 0.75rem; color: var(--text-secondary); margin-top: 4px; }
</style>
