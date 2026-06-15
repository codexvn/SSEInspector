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
        <span>{{ p.label }}</span>
        <span class="val">{{ p.value.toLocaleString() }} ({{ Math.round(p.value / total * 100) }}%)</span>
      </div>
    </div>
    <div class="total-row">
      <span>输入合计（我们计算）</span><span>{{ total.toLocaleString() }}</span>
    </div>
    <div v-if="tb?.apiReportedInput" class="total-row api-row">
      <span>API 报告输入</span><span>{{ tb.apiReportedInput.toLocaleString() }}</span>
    </div>
    <div v-if="tb?.cacheRead" class="total-row cache-row">
      <span>缓存命中 cache_read</span>
      <span>{{ tb.cacheRead.toLocaleString() }} (命中率 {{ tb.apiReportedInput ? (tb.cacheRead / tb.apiReportedInput * 100).toFixed(6) : '0' }}%)</span>
    </div>
    <div v-if="tb?.tokenizerSource" class="source">tokenizer: {{ tb.tokenizerSource }}</div>
  </div>
</template>

<style scoped>
.token-card { background: var(--bg-card); border-radius: 8px; padding: 14px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
.title { font-weight: 600; margin-bottom: 8px; font-size: 0.9rem; }
.bar-wrap { display: flex; height: 8px; border-radius: 4px; overflow: hidden; margin-bottom: 8px; }
.bar { height: 100%; }
.bar.msg { background: #6366f1; }
.bar.tool { background: #f59e0b; }
.bar.sys { background: #10b981; }
.legend { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
.legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.8rem; }
.dot { width: 10px; height: 10px; border-radius: 2px; }
.dot.msg { background: #6366f1; }
.dot.tool { background: #f59e0b; }
.dot.sys { background: #10b981; }
.val { margin-left: auto; color: var(--text-secondary); }
.total-row { display: flex; justify-content: space-between; font-size: 0.8rem; padding: 2px 0; }
.api-row { color: var(--text-secondary); }
.cache-row { color: var(--accent); }
.source { font-size: 0.75rem; color: var(--text-secondary); margin-top: 4px; }
</style>
