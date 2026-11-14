<script setup lang="ts">
/**
 * F12 Network「时间」面板风格的耗时分解：分段彩条 + 图例清单。
 * 四段口径（后端打点，见 format-timing.ts）：发送请求（请求体上传）→
 * 响应头到达 → 等待首字（TTFB，服务端处理）→ 内容下载（流式接收）。
 * 图例附网络字节、吞吐、chunk 数与压缩比；出现停顿（相邻 chunk 间隔 ≥1s）
 * 时追加红色停顿行——VPN 抖动的直接信号。
 *
 * 交互分三种形态：旧记录（终态但无打点）整卡隐藏；等待首字（pending /
 * 响应已开始但首字节未到）显示「发送段 + 等待中」的进行态；首字到达后
 * 显示完整分解（传输中实时刷新）。
 */
import { computed, ref } from 'vue'
import { formatDuration } from '../format-timing'
import { formatBytes } from '../format'

const props = defineProps<{
  state: 'pending' | 'streaming' | 'done' | 'error'
  requestSentMs?: number
  responseStartMs?: number
  firstChunkMs?: number
  durationMs?: number
  requestBytes?: number
  responseBytes?: number
  responseChunkCount?: number
  responseMaxGapMs?: number
  responseStallCount?: number
  responseDecodedBytes?: number
}>()

interface Segment {
  key: string
  label: string
  ms: number
  color: string
  note?: string
}

const totalMs = computed(() => props.durationMs ?? 0)

/** 默认折叠：头部常显总计与状态，点击头部展开完整彩条与图例 */
const expanded = ref(false)

/** 终态但无打点 = 旧数据，整卡隐藏 */
const hidden = computed(() => props.firstChunkMs == null && (props.state === 'done' || props.state === 'error'))

/** 首字未到且仍在进行 = 等待首字形态（发送段 + 等待提示） */
const waitingFirstChunk = computed(() => props.firstChunkMs == null && !hidden.value)

/** 发送段占整条的比例（等待形态下彩条只有这一段是实心的） */
const sendRatio = computed(() => {
  if (totalMs.value <= 0 || props.requestSentMs == null) return 0
  return Math.min(100, (props.requestSentMs / totalMs.value) * 100)
})

/** 压缩比：解压后字节数 ÷ 线上字节数（明文响应或数据缺失时为空） */
const compressionRatio = computed(() => {
  if (props.responseDecodedBytes == null || !props.responseBytes || props.responseDecodedBytes < props.responseBytes) return undefined
  return `${(props.responseDecodedBytes / props.responseBytes).toFixed(1)}×`
})

/** 上传速度：请求字节 ÷ 发送耗时（字节 > 0 且耗时已知才显示，GET 空体不显示 0 B/s） */
const uploadSpeed = computed(() => {
  if (!props.requestBytes || !props.requestSentMs) return undefined
  return `${formatBytes(Math.round((props.requestBytes / props.requestSentMs) * 1000))}/s`
})

const segments = computed<Segment[]>(() => {
  const first = props.firstChunkMs
  if (first == null) return []
  const sentMs = props.requestSentMs ?? 0
  // 响应头到达缺失时退回首字时刻（该段为 0 自动隐藏，段宽不失真）
  const headerAt = props.responseStartMs ?? first
  const headerMs = Math.max(0, headerAt - sentMs)
  const waitMs = Math.max(0, first - headerAt)
  const downloadMs = Math.max(0, totalMs.value - first)
  const throughput = downloadMs > 0 && props.responseBytes != null
    ? `${formatBytes(Math.round((props.responseBytes / downloadMs) * 1000))}/s`
    : undefined
  const sendNotes: string[] = []
  if (props.requestBytes != null) sendNotes.push(formatBytes(props.requestBytes))
  if (uploadSpeed.value) sendNotes.push(uploadSpeed.value)
  const downloadNotes: string[] = []
  if (props.responseBytes != null) downloadNotes.push(formatBytes(props.responseBytes))
  if (throughput) downloadNotes.push(throughput)
  if (props.responseChunkCount != null) downloadNotes.push(`${props.responseChunkCount} chunk`)
  if (compressionRatio.value) downloadNotes.push(`压缩 ${compressionRatio.value}`)
  return [
    {
      key: 'send',
      label: '发送请求',
      ms: sentMs,
      color: '#7b9af7',
      note: sendNotes.length > 0 ? sendNotes.join(' · ') : undefined,
    },
    { key: 'header', label: '响应头到达', ms: headerMs, color: '#fbbc04' },
    { key: 'wait', label: '等待首字（TTFB）', ms: waitMs, color: '#34a853' },
    {
      key: 'download',
      label: '内容下载',
      ms: downloadMs,
      color: '#4285f4',
      note: downloadNotes.length > 0 ? downloadNotes.join(' · ') : undefined,
    },
    // 0ms 段隐藏（F12 同样只显示发生过的阶段）；等待首字保留（核心指标）
  ].filter(seg => seg.ms > 0 || seg.key === 'wait')
})

const hasData = computed(() => segments.value.length > 0 && totalMs.value > 0)

/** 有停顿才显示停顿行（≥1s 的相邻 chunk 间隔） */
const stalled = computed(() => (props.responseStallCount ?? 0) > 0)
</script>

<template>
  <div v-if="!hidden" class="tw-card">
    <div class="tw-header" role="button" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="tw-chevron" aria-hidden="true">{{ expanded ? '▼' : '▶' }}</span>
      <span class="tw-title">耗时分解</span>
      <span v-if="waitingFirstChunk" class="tw-live">● 等待首字</span>
      <span v-else-if="state === 'streaming'" class="tw-live">● 传输中</span>
      <span class="tw-total">{{ formatDuration(totalMs) }}</span>
    </div>

    <!-- 等待首字形态：发送段实心 + 其余为空轨道，图例显示等待提示与已用时间 -->
    <template v-if="expanded && waitingFirstChunk">
      <div class="tw-bar">
        <span v-if="sendRatio > 0" class="tw-seg" :style="{ width: `${Math.max(0.5, sendRatio)}%`, background: '#7b9af7' }" />
      </div>
      <div class="tw-legend">
        <div class="tw-row">
          <span class="tw-dot" style="background: #7b9af7" />
          <span class="tw-label">发送请求</span>
          <span v-if="requestBytes != null" class="tw-note">{{ [formatBytes(requestBytes), uploadSpeed].filter(Boolean).join(' · ') }}</span>
          <span class="tw-ms">{{ requestSentMs != null ? formatDuration(requestSentMs) : '—' }}</span>
        </div>
        <div class="tw-row">
          <span class="tw-dot tw-dot-pending" />
          <span class="tw-label">等待首字</span>
          <span class="tw-ms">已用 {{ formatDuration(totalMs) }}</span>
        </div>
      </div>
    </template>

    <!-- 完整分解形态：四段彩条（宽度按占比，最小 0.5% 保证可见）+ 图例 + 停顿行 -->
    <template v-else-if="expanded && hasData">
      <div class="tw-bar">
        <span
          v-for="seg in segments"
          :key="seg.key"
          class="tw-seg"
          :style="{ width: `${Math.max(0.5, (seg.ms / totalMs) * 100)}%`, background: seg.color }"
        />
      </div>
      <div class="tw-legend">
        <div v-for="seg in segments" :key="seg.key" class="tw-row">
          <span class="tw-dot" :style="{ background: seg.color }" />
          <span class="tw-label">{{ seg.label }}</span>
          <span v-if="seg.note" class="tw-note">{{ seg.note }}</span>
          <span class="tw-ms">{{ formatDuration(seg.ms) }}</span>
        </div>
        <div v-if="stalled" class="tw-row tw-row-stall">
          <span class="tw-dot" style="background: #ea4335" />
          <span class="tw-label">流式停顿</span>
          <span class="tw-note">相邻 chunk 间隔 ≥1s</span>
          <span class="tw-ms">{{ responseStallCount }} 次 · 最长 {{ formatDuration(responseMaxGapMs ?? 0) }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.tw-card {
  background: var(--bg-card);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  padding: 14px 18px;
  margin-bottom: 12px;
  /* 与详情页其他卡片同宽（全宽），彩条获得最大分辨率 */
}
.tw-header {
  display: flex; align-items: center; gap: 10px;
  cursor: pointer; user-select: none;
}
.tw-header:hover .tw-title { color: var(--accent); }
.tw-chevron { font-size: 0.7rem; color: var(--text-muted); width: 1em; }
.tw-title { font-size: 0.78rem; font-weight: 650; color: var(--text-primary); }
.tw-live { font-size: 0.72rem; color: var(--accent); font-weight: 600; }
.tw-total { margin-left: auto; font: 0.76rem var(--font-mono); color: var(--text-secondary); }
.tw-bar {
  display: flex; height: 8px; border-radius: 4px; overflow: hidden;
  background: var(--bg-inset); margin: 12px 0;
}
.tw-seg { min-width: 2px; height: 100%; }
.tw-legend { display: flex; flex-direction: column; gap: 6px; }
.tw-row { display: flex; align-items: center; gap: 8px; font-size: 0.78rem; }
.tw-row-stall .tw-label { color: #c5221f; font-weight: 600; }
.tw-dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
/* 等待首字行：呼吸动画的空点表示进行中 */
.tw-dot-pending {
  background: var(--accent);
  opacity: 0.45;
  animation: tw-pulse 1.2s ease-in-out infinite;
}
@keyframes tw-pulse {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 0.85; }
}
.tw-label { color: var(--text-primary); }
.tw-note { color: var(--text-muted); font: 0.72rem var(--font-mono); }
.tw-ms { margin-left: auto; font: 0.76rem var(--font-mono); color: var(--text-secondary); }
</style>
