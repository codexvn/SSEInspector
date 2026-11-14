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
  timestamp?: string
  method?: string
  requestSentMs?: number
  responseStartMs?: number
  firstChunkMs?: number
  durationMs?: number
  requestBytes?: number
  responseBytes?: number
  responseChunkCount?: number
  responseMaxGapMs?: number
  responseMaxGapAt?: number
  responseMaxGapChunksBefore?: number
  responseStallCount?: number
  responseDecodedBytes?: number
  responseChunkTimeline?: Array<[number, number, number, number, number]>
  /** 解码后的响应原文（HTTP 路径与 chunk 字符区间同源，点击 chunk 时按区间切出内容） */
  responseBody?: string
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

/** 停顿发生时刻与前后 chunk 分布：并发请求同一时刻一起停 = 网络停流；各自随机停 = 服务端调度 */
const stallEvidence = computed(() => {
  const parts: string[] = []
  if (props.responseMaxGapAt != null) {
    parts.push(`发生于 ${new Date(props.responseMaxGapAt).toLocaleTimeString('zh-CN', { hour12: false })}`)
  }
  if (props.responseMaxGapChunksBefore != null && props.responseChunkCount != null) {
    const after = Math.max(0, props.responseChunkCount - props.responseMaxGapChunksBefore)
    parts.push(`前 ${props.responseMaxGapChunksBefore} · 后 ${after} chunk`)
  }
  return parts.length > 0 ? parts.join(' · ') : undefined
})

// ---- chunk 时间线（内容下载阶段）：按时间刻度铺开，悬停任意刻度看该 chunk 明细 ----

/** 与后端停顿阈值一致 */
const CHUNK_STALL_GAP_MS = 1000
/** DOM 渲染上限：异常超大流只画前 N 个刻度（数据完整存库） */
const TIMELINE_RENDER_LIMIT = 2000

const downloadMs = computed(() =>
  props.firstChunkMs != null ? Math.max(0, totalMs.value - props.firstChunkMs) : 0)

const timeline = computed(() => props.responseChunkTimeline?.slice(0, TIMELINE_RENDER_LIMIT) ?? [])
const hoveredChunk = ref<number | null>(null)
/** 点击选中的 chunk：弹出内容小框（内容超一行自动换行） */
const selectedChunk = ref<number | null>(null)

function toggleChunk(index: number): void {
  selectedChunk.value = selectedChunk.value === index ? null : index
}

/** 选中 chunk 的内容：按字符区间从响应原文切出（WS 记录的 responseBody 是原始信封，
 *  与 chunk 区间不同源，退回提示） */
const selectedChunkContent = computed(() => {
  if (selectedChunk.value == null) return undefined
  const entry = timeline.value[selectedChunk.value]
  if (entry == null) return undefined
  if (props.method === 'WS' || props.responseBody == null) {
    return { text: '（WS 记录的响应原文为原始信封，与本区间不同源；内容请看响应体视图）', partial: true }
  }
  return { text: props.responseBody.slice(entry[3], entry[4]) || '（空 chunk）', partial: false }
})

/** 弹框定位：按 chunk 位置百分比，边缘钳制防溢出 */
const selectedChunkLeftPct = computed(() => {
  if (selectedChunk.value == null) return 50
  const entry = timeline.value[selectedChunk.value]
  if (entry == null || downloadMs.value <= 0) return 50
  return Math.min(70, Math.max(30, (entry[0] / downloadMs.value) * 100))
})

/** 时间轴刻度步长：目标 10 根以内 */
const tickStepMs = computed(() => {
  const steps = [100, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000]
  return steps.find(step => downloadMs.value / step <= 10) ?? 60_000
})

const ticks = computed(() => {
  const marks: number[] = []
  for (let t = 0; t <= downloadMs.value; t += tickStepMs.value) marks.push(t)
  return marks
})

/** 首 chunk 的墙钟时刻：请求起点 + 首字耗时（时间线刻度的悬停时间由此换算） */
const firstChunkWallMs = computed(() => {
  if (!props.timestamp || props.firstChunkMs == null) return null
  const start = Date.parse(props.timestamp)
  return Number.isFinite(start) ? start + props.firstChunkMs : null
})

function chunkWallTime(index: number): string {
  const entry = timeline.value[index]
  if (entry == null || firstChunkWallMs.value == null) return ''
  const at = new Date(firstChunkWallMs.value + entry[0])
  return `${at.toLocaleTimeString('zh-CN', { hour12: false })}.${String(at.getMilliseconds()).padStart(3, '0')}`
}
</script>

<template>
  <div v-if="!hidden" class="tw-card" @click="selectedChunk = null">
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
          <span v-if="stallEvidence" class="tw-note">{{ stallEvidence }}</span>
          <span class="tw-ms">{{ responseStallCount }} 次 · 最长 {{ formatDuration(responseMaxGapMs ?? 0) }}</span>
        </div>
        <!-- chunk 时间线：内容下载阶段按时间刻度铺开；停顿的 chunk 标红，悬停看明细 -->
        <div v-if="timeline.length > 0 && downloadMs > 0" class="tw-timeline-block">
          <div class="tw-timeline">
            <span
              v-for="(t, i) in ticks"
              :key="`grid-${i}`"
              class="tw-grid"
              :style="{ left: `${(t / downloadMs) * 100}%` }"
            />
            <span
              v-for="(c, i) in timeline"
              :key="`chunk-${i}`"
              class="tw-chunk"
              :class="{ 'tw-chunk-stall': c[2] >= CHUNK_STALL_GAP_MS, 'tw-chunk-hover': hoveredChunk === i, 'tw-chunk-selected': selectedChunk === i }"
              :style="{ left: `${(c[0] / downloadMs) * 100}%` }"
              @mouseenter="hoveredChunk = i"
              @mouseleave="hoveredChunk = null"
              @click.stop="toggleChunk(i)"
            />
            <!-- 悬停浮签：单行时刻信息 -->
            <div
              v-if="hoveredChunk != null && timeline[hoveredChunk] && selectedChunk !== hoveredChunk"
              class="tw-tip"
              :style="{ left: `${Math.min(96, Math.max(4, (timeline[hoveredChunk][0] / downloadMs) * 100))}%` }"
            >
              #{{ hoveredChunk + 1 }} · {{ chunkWallTime(hoveredChunk) }} · 间隔 +{{ timeline[hoveredChunk][2] }}ms · {{ timeline[hoveredChunk][1] }} B
            </div>
            <!-- 点击弹框：chunk 内容（超一行自动换行，可滚动） -->
            <div v-if="selectedChunk != null && selectedChunkContent" class="tw-popover" :style="{ left: `${selectedChunkLeftPct}%` }" @click.stop>
              <div class="tw-popover-head">
                <span>#{{ selectedChunk + 1 }} · {{ chunkWallTime(selectedChunk) }} · 间隔 +{{ timeline[selectedChunk]?.[2] }}ms · {{ timeline[selectedChunk]?.[1] }} B</span>
                <button class="tw-popover-close" type="button" @click="selectedChunk = null">×</button>
              </div>
              <pre class="tw-popover-body">{{ selectedChunkContent.text }}</pre>
            </div>
            <div class="tw-axis">
              <span
                v-for="(t, i) in ticks"
                :key="`label-${i}`"
                class="tw-axis-label"
                :style="{ left: `${(t / downloadMs) * 100}%` }"
              >{{ formatDuration(t) }}</span>
            </div>
          </div>
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

/* ---- chunk 时间线 ---- */
.tw-timeline-block { margin-top: 12px; }
.tw-timeline { position: relative; height: 48px; }
.tw-grid {
  position: absolute; top: 0; bottom: 16px; width: 1px;
  background: var(--border); pointer-events: none;
}
.tw-chunk {
  position: absolute; top: 14px; width: 3px; height: 12px; margin-left: -1.5px;
  background: #4285f4; opacity: 0.7; border-radius: 1px; cursor: pointer;
}
/* 悬停高亮：加亮加宽并整条提亮 */
.tw-chunk-hover, .tw-chunk:hover {
  opacity: 1; background: #1a73e8; width: 5px; margin-left: -2.5px; z-index: 1;
}
/* 选中态：常亮描边 */
.tw-chunk-selected {
  opacity: 1; background: #1a73e8; width: 5px; margin-left: -2.5px; z-index: 1;
  box-shadow: 0 0 0 2px #c6dafc;
}
/* 停顿 chunk（该 chunk 与上一 chunk 间隔 ≥1s）：红色加高突出 */
.tw-chunk-stall { background: #ea4335; height: 16px; top: 12px; }
.tw-chunk-stall.tw-chunk-hover, .tw-chunk-stall.tw-chunk-selected, .tw-chunk-stall:hover { background: #c5221f; }
.tw-tip {
  position: absolute; top: -6px; transform: translateX(-50%);
  background: #1f2937; color: #fff; font: 0.7rem var(--font-mono);
  padding: 3px 8px; border-radius: 4px; white-space: nowrap;
  pointer-events: none; z-index: 2;
}
/* 点击弹框：内容可多行展示（pre-wrap 断行，超高滚动） */
.tw-popover {
  position: absolute; top: 26px; transform: translateX(-50%);
  width: min(520px, 92%); background: #1f2937; color: #f3f4f6;
  border-radius: 6px; padding: 8px 10px; z-index: 3;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
}
.tw-popover-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font: 0.7rem var(--font-mono); color: #d1d5db; margin-bottom: 6px;
}
.tw-popover-close {
  border: none; background: transparent; color: #9ca3af; cursor: pointer;
  font-size: 0.95rem; line-height: 1; padding: 0 2px;
}
.tw-popover-close:hover { color: #fff; }
.tw-popover-body {
  margin: 0; max-height: 180px; overflow: auto;
  white-space: pre-wrap; word-break: break-all;
  font: 0.72rem var(--font-mono); color: #e5e7eb; line-height: 1.5;
}
.tw-axis { position: absolute; left: 0; right: 0; bottom: 0; height: 14px; }
.tw-axis-label {
  position: absolute; transform: translateX(-50%);
  font: 0.62rem var(--font-mono); color: var(--text-muted);
}
.tw-axis-label:first-child { transform: none; }
</style>
