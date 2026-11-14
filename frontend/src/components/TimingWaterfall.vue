<script setup lang="ts">
/**
 * F12 Network「时间」面板风格的耗时分解：分段彩条 + 图例清单。
 * 四段口径（后端打点，见 format-timing.ts）：发送请求（请求体上传）→
 * 响应头到达 → 等待首字（TTFB，服务端处理）→ 内容下载（流式接收）。
 * 图例附网络字节、吞吐、chunk 数与压缩比。
 *
 * 交互：旧记录（终态但无打点）整卡隐藏；等待首字显示进行态；完整形态下
 * 点击彩条的「内容下载」段打开独立大弹框——内含按时间铺开的 chunk 密度
 * 柱（柱高 = 该时刻 chunk 数），悬停柱在弹框下方内容区看到该批 chunk 的
 * 真实内容。
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
  responseDecodedBytes?: number
  responseChunkTimeline?: Array<[number, number, number, number]>
  /** 解码后的响应原文（HTTP 路径与 chunk 字符区间同源，悬停时按区间切出内容） */
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

/** 上传速度：请求字节 ÷ 发送耗时（字节 > 0 且耗时已知才显示，GET 空体不显示 0 B/s） */
const uploadSpeed = computed(() => {
  if (!props.requestBytes || !props.requestSentMs) return undefined
  return `${formatBytes(Math.round((props.requestBytes / props.requestSentMs) * 1000))}/s`
})

/** 压缩比：解压后字节数 ÷ 线上字节数（明文响应或数据缺失时为空） */
const compressionRatio = computed(() => {
  if (props.responseDecodedBytes == null || !props.responseBytes || props.responseDecodedBytes < props.responseBytes) return undefined
  return `${(props.responseDecodedBytes / props.responseBytes).toFixed(1)}×`
})

const downloadMs = computed(() =>
  props.firstChunkMs != null ? Math.max(0, totalMs.value - props.firstChunkMs) : 0)

/** 内容下载段在整条上的起点与宽度（百分比）：既是悬停提示区也是时间线弹框的点击入口 */
const downloadSegLeftPct = computed(() =>
  props.firstChunkMs != null && totalMs.value > 0 ? (props.firstChunkMs / totalMs.value) * 100 : 100)
const downloadSegWidthPct = computed(() =>
  totalMs.value > 0 ? (downloadMs.value / totalMs.value) * 100 : 0)

const segments = computed<Segment[]>(() => {
  const first = props.firstChunkMs
  if (first == null) return []
  const sentMs = props.requestSentMs ?? 0
  // 响应头到达缺失时退回首字时刻（该段为 0 自动隐藏，段宽不失真）
  const headerAt = props.responseStartMs ?? first
  const headerMs = Math.max(0, headerAt - sentMs)
  const waitMs = Math.max(0, first - headerAt)
  const downloadMsValue = Math.max(0, totalMs.value - first)
  const throughput = downloadMsValue > 0 && props.responseBytes != null
    ? `${formatBytes(Math.round((props.responseBytes / downloadMsValue) * 1000))}/s`
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
      ms: downloadMsValue,
      color: '#4285f4',
      note: downloadNotes.length > 0 ? downloadNotes.join(' · ') : undefined,
    },
    // 0ms 段隐藏（F12 同样只显示发生过的阶段）；等待首字保留（核心指标）
  ].filter(seg => seg.ms > 0 || seg.key === 'wait')
})

const hasData = computed(() => segments.value.length > 0 && totalMs.value > 0)

// ---- chunk 时间线弹框：点击内容下载段打开，悬停密度柱看内容 ----

/** DOM 渲染上限：异常超大流只取前 N 个 chunk（数据完整存库） */
const TIMELINE_RENDER_LIMIT = 2000

const timelineOpen = ref(false)
const timeline = computed(() => props.responseChunkTimeline?.slice(0, TIMELINE_RENDER_LIMIT) ?? [])
const canOpenTimeline = computed(() => timeline.value.length > 0 && downloadMs.value > 0)

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

/** 首 chunk 的墙钟时刻：请求起点 + 首字耗时（刻度悬停时间由此换算） */
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

/** 悬停中的桶 */
const hoveredBucket = ref<number | null>(null)

/** chunk 内容美化：SSE 事件的 data JSON 缩进展开，长单行不再挤成一团 */
function formatChunkContent(raw: string): string {
  return raw
    .split('\n')
    .map(line => {
      if (!line.startsWith('data: ')) return line
      const payload = line.slice(6)
      try {
        return `data: ${JSON.stringify(JSON.parse(payload), null, 2)}`
      } catch {
        return line
      }
    })
    .join('\n')
}

/**
 * 密度聚合：爆发期 chunk 在同一像素区互相重叠成一团，无法逐个悬停。
 * 按固定桶数把时间线聚合成密度柱——柱高对应该桶 chunk 数，悬停桶在
 * 下方内容区展开桶内全部 chunk 的内容。
 */
const BUCKET_COUNT = 120

interface TimelineBucket {
  /** 桶起点相对首 chunk 的偏移 ms */
  offsetMs: number
  count: number
  /** 桶内 chunk 在 timeline 中的下标 */
  indices: number[]
}

const buckets = computed<TimelineBucket[]>(() => {
  const list = timeline.value
  if (list.length === 0 || downloadMs.value <= 0) return []
  const widthMs = downloadMs.value / BUCKET_COUNT
  const byStart = new Map<number, TimelineBucket>()
  for (let i = 0; i < list.length; i++) {
    const start = Math.min(BUCKET_COUNT - 1, Math.floor(list[i][0] / widthMs)) * widthMs
    let bucket = byStart.get(start)
    if (!bucket) {
      bucket = { offsetMs: start, count: 0, indices: [] }
      byStart.set(start, bucket)
    }
    bucket.count += 1
    bucket.indices.push(i)
  }
  return [...byStart.values()].sort((a, b) => a.offsetMs - b.offsetMs)
})

const maxBucketCount = computed(() => buckets.value.reduce((max, b) => Math.max(max, b.count), 0))

/** 桶柱高：单 chunk 矮柱，密度越高越高，封顶 26px */
function bucketHeightPx(count: number): number {
  if (count <= 1) return 10
  return Math.round(10 + 16 * Math.min(1, (count - 1) / Math.max(1, maxBucketCount.value - 1)))
}

const bucketWidthPct = computed(() => (100 / BUCKET_COUNT) * 0.72)

/** 单桶内容展开上限：超出截断提示（防御桶内 chunk 数异常大） */
const BUCKET_SHOW_LIMIT = 40

const hoverInfo = computed(() => {
  if (hoveredBucket.value == null) return undefined
  const bucket = buckets.value[hoveredBucket.value]
  if (bucket == null) return undefined
  const first = timeline.value[bucket.indices[0]]
  if (first == null) return undefined
  const range = bucket.count === 1
    ? `#${bucket.indices[0] + 1}`
    : `#${bucket.indices[0] + 1}–#${bucket.indices[bucket.indices.length - 1] + 1}（${bucket.count} 个）`
  const head = `${range} · ${chunkWallTime(bucket.indices[0])} 起`
  if (props.method === 'WS' || props.responseBody == null) {
    return { head, text: '（WS 记录的响应原文为原始信封，与本区间不同源；内容请看响应体视图）' }
  }
  const shown = bucket.indices.slice(0, BUCKET_SHOW_LIMIT)
  const parts = shown.map(idx => {
    const entry = timeline.value[idx]
    const content = formatChunkContent(props.responseBody!.slice(entry[2], entry[3]) || '（空 chunk）')
    return bucket.count === 1 ? content : `── #${idx + 1} · ${entry[1]} B ──\n${content}`
  })
  if (bucket.count > BUCKET_SHOW_LIMIT) parts.push(`……其余 ${bucket.count - BUCKET_SHOW_LIMIT} 个 chunk 略`)
  return { head, text: parts.join('\n') }
})
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

    <!-- 等待首字形态：发送段实心 + 其余为空轨道 -->
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

    <!-- 完整分解形态：四段彩条 + 图例；点击内容下载段打开 chunk 时间线弹框 -->
    <template v-else-if="expanded && hasData">
      <div class="tw-bar-wrap">
        <div class="tw-bar">
          <span
            v-for="seg in segments"
            :key="seg.key"
            class="tw-seg"
            :style="{ width: `${Math.max(0.5, (seg.ms / totalMs) * 100)}%`, background: seg.color }"
          />
          <!-- 内容下载段点击区：打开 chunk 时间线弹框（有数据才可点） -->
          <span
            v-if="canOpenTimeline"
            class="tw-seg-click"
            :style="{ left: `${downloadSegLeftPct}%`, width: `${Math.max(0.5, downloadSegWidthPct)}%` }"
            title="点击查看 chunk 时间线"
            @click.stop="timelineOpen = true"
          />
        </div>
      </div>
      <div class="tw-legend">
        <div v-for="seg in segments" :key="seg.key" class="tw-row">
          <span class="tw-dot" :style="{ background: seg.color }" />
          <span class="tw-label">{{ seg.label }}</span>
          <span v-if="seg.note" class="tw-note">{{ seg.note }}</span>
          <span class="tw-ms">{{ formatDuration(seg.ms) }}</span>
        </div>
      </div>
    </template>

    <!-- chunk 时间线大弹框：点击内容下载段打开；刻度按到达时刻铺开，悬停刻度在下方内容区看真实内容 -->
    <Teleport to="body">
      <div v-if="timelineOpen" class="tw-modal-overlay" @click.self="timelineOpen = false">
        <div class="tw-modal">
          <div class="tw-modal-head">
            <span class="tw-modal-title">chunk 时间线 · 内容下载 {{ formatDuration(downloadMs) }}</span>
            <span class="tw-modal-sub">{{ timeline.length }} 个 chunk · 悬停密度柱查看内容</span>
            <button class="tw-modal-close" type="button" @click="timelineOpen = false">×</button>
          </div>
          <div class="tw-timeline">
            <span
              v-for="(t, i) in ticks"
              :key="`grid-${i}`"
              class="tw-grid"
              :style="{ left: `${(t / downloadMs) * 100}%` }"
            />
            <span
              v-for="(b, i) in buckets"
              :key="`bucket-${i}`"
              class="tw-mark"
              :class="{ 'tw-mark-hover': hoveredBucket === i }"
              :style="{ left: `${(b.offsetMs / downloadMs) * 100}%`, width: `${bucketWidthPct}%`, height: `${bucketHeightPx(b.count)}px` }"
              @mouseenter="hoveredBucket = i"
              @mouseleave="hoveredBucket = null"
            />
            <div class="tw-axis">
              <span
                v-for="(t, i) in ticks"
                :key="`label-${i}`"
                class="tw-axis-label"
                :style="{ left: `${(t / downloadMs) * 100}%` }"
              >{{ formatDuration(t) }}</span>
            </div>
          </div>
          <!-- 悬停内容区：显示当前悬停刻度的信息与该 chunk 的真实内容 -->
          <div class="tw-hover-panel">
            <div v-if="hoverInfo" class="tw-hover-head">{{ hoverInfo.head }}</div>
            <pre v-if="hoverInfo" class="tw-hover-body">{{ hoverInfo.text }}</pre>
            <div v-else class="tw-hover-empty">悬停上方刻度查看对应 chunk 的到达时刻与内容</div>
          </div>
        </div>
      </div>
    </Teleport>
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
.tw-bar-wrap { position: relative; }
.tw-bar {
  display: flex; height: 8px; border-radius: 4px; overflow: hidden;
  background: var(--bg-inset); margin: 12px 0;
  position: relative;
}
.tw-seg { min-width: 2px; height: 100%; }
/* 内容下载段点击区：透明覆盖，hover 提示可点 */
.tw-seg-click {
  position: absolute; top: 0; height: 100%; cursor: zoom-in;
  outline: 1px dashed transparent;
}
.tw-seg-click:hover { outline-color: rgba(255, 255, 255, 0.8); background: rgba(255, 255, 255, 0.15); }
.tw-legend { display: flex; flex-direction: column; gap: 6px; }
.tw-row { display: flex; align-items: center; gap: 8px; font-size: 0.78rem; }
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

/* ---- chunk 时间线大弹框 ---- */
.tw-modal-overlay {
  position: fixed; inset: 0; z-index: 40;
  background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center;
}
.tw-modal {
  width: min(960px, 94vw); max-height: 88vh; overflow: auto;
  background: var(--bg-card); border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
  padding: 16px 20px 18px;
}
.tw-modal-head {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin-bottom: 14px;
}
.tw-modal-title { font-size: 0.9rem; font-weight: 650; color: var(--text-primary); }
/* 副标题独占整行，超宽自动换行，不与标题/关闭按钮挤在一行 */
.tw-modal-sub { flex-basis: 100%; font-size: 0.74rem; color: var(--text-muted); line-height: 1.5; }
.tw-modal-close {
  margin-left: auto; border: none; background: transparent; color: var(--text-muted);
  font-size: 1.1rem; line-height: 1; cursor: pointer; padding: 2px 4px;
}
.tw-modal-close:hover { color: var(--text-primary); }
.tw-timeline { position: relative; height: 56px; }
.tw-grid {
  position: absolute; top: 0; bottom: 18px; width: 1px;
  background: var(--border); pointer-events: none;
}
/* 密度柱：底边对齐时间轴，柱高按桶内 chunk 数（样式随内联 height/left/width） */
.tw-mark {
  position: absolute; bottom: 20px;
  background: #4285f4; opacity: 0.6; border-radius: 2px; cursor: pointer;
}
.tw-mark-hover {
  opacity: 1; background: #1a73e8; z-index: 1;
  box-shadow: 0 0 0 2px #c6dafc;
}
.tw-axis { position: absolute; left: 0; right: 0; bottom: 0; height: 16px; }
.tw-axis-label {
  position: absolute; transform: translateX(-50%);
  font: 0.66rem var(--font-mono); color: var(--text-muted);
}
.tw-axis-label:first-child { transform: none; }
/* 悬停内容区：固定高度——悬停内容出现/变化不改变弹窗高度，消除上下抖动 */
.tw-hover-panel {
  margin-top: 10px; border-top: 1px solid var(--border); padding-top: 10px;
  height: 300px; display: flex; flex-direction: column;
}
.tw-hover-head {
  flex: none;
  font: 0.74rem var(--font-mono); color: var(--text-secondary); margin-bottom: 6px;
}
.tw-hover-body {
  flex: 1; min-height: 0; margin: 0; overflow: auto;
  white-space: pre-wrap; word-break: break-all;
  font: 0.74rem var(--font-mono); color: var(--text-primary); line-height: 1.55;
  background: var(--bg-inset); border-radius: 6px; padding: 10px 12px;
}
.tw-hover-empty {
  flex: 1; display: flex; align-items: center; justify-content: center;
  font-size: 0.76rem; color: var(--text-muted);
}
</style>
