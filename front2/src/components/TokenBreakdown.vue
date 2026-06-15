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
  color: var(--text-secondary); font-weight: 600; margin-bottom: 12px;
}
.bar-wrap { display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: #f1f3f5; margin-bottom: 14px; }
.bar { height: 100%; min-width: 3px; transition: width .3s ease; }
.bar.msg { background: #6366f1; }
.bar.tool { background: #f59e0b; }
.bar.sys { background: #10b981; }
.legend { display: flex; gap: 20px; margin-bottom: 14px; flex-wrap: wrap; }
.legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.82rem; color: var(--text-primary); }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.dot.msg { background: #6366f1; }
.dot.tool { background: #f59e0b; }
.dot.sys { background: #10b981; }
.legend-label { font-weight: 500; }
.legend-val { font-family: var(--font-mono); font-size: 0.78rem; color: var(--text-secondary); }
.total-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 0; font-size: 0.82rem; color: var(--text-primary);
  border-top: 1px solid var(--border); font-family: var(--font-mono);
}
.api-row { color: var(--text-secondary); font-size: 0.78rem; }
.cache-row { color: var(--text-muted); font-size: 0.78rem; }
.token-diff { color: var(--warning); font-weight: 600; }
.source {
  font-size: 0.68rem; color: var(--text-muted); text-align: right;
  margin-top: 6px; font-family: var(--font-mono);
}
</style>
