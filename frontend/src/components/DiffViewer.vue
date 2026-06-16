<script setup lang="ts">
import { computed, ref } from 'vue'

const props = withDefaults(defineProps<{
  oldString: string
  newString: string
  oldLabel?: string
  newLabel?: string
  mode?: 'unified' | 'split'
  context?: number
  collapsed?: boolean
}>(), {
  oldLabel: '旧',
  newLabel: '新',
  mode: 'unified',
  context: 3,
  collapsed: true,
})

const linesContainer = ref<HTMLElement | null>(null)
const splitLeftPane = ref<HTMLElement | null>(null)
const splitRightPane = ref<HTMLElement | null>(null)

// ---- 左右同步横向滚动 ----
function onSplitScroll(e: Event) {
  const src = (e.target as HTMLElement).closest('.split-scroll') as HTMLElement
  const left = splitLeftPane.value
  const right = splitRightPane.value
  if (!left || !right) return
  if (src === left) {
    right.scrollTop = left.scrollTop
    right.scrollLeft = left.scrollLeft
  } else if (src === right) {
    left.scrollTop = right.scrollTop
    left.scrollLeft = right.scrollLeft
  }
}

// ---- types ----
type RawType = 'unchanged' | 'added' | 'removed'
interface RawLine { type: RawType; oldLineNum?: number; newLineNum?: number; text: string }

// ---- LCS diff engine ----
const rawLines = computed<RawLine[]>(() => {
  const oldLines = props.oldString ? props.oldString.split('\n') : []
  const newLines = props.newString ? props.newString.split('\n') : []
  const m = oldLines.length, n = newLines.length

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  const raw: RawLine[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      raw.unshift({ type: 'unchanged', oldLineNum: i, newLineNum: j, text: oldLines[i - 1] })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.unshift({ type: 'added', newLineNum: j, text: newLines[j - 1] })
      j--
    } else {
      raw.unshift({ type: 'removed', oldLineNum: i, text: oldLines[i - 1] })
      i--
    }
  }
  return raw
})

// ---- unified 模式 ----
interface UnifiedLine {
  type: 'unchanged' | 'added' | 'removed' | 'ellipsis'
  oldLineNum?: number
  newLineNum?: number
  text: string
}

const unifiedLines = computed<UnifiedLine[]>(() => {
  if (!rawLines.value.length) return []
  const ctx = props.collapsed ? props.context : 0
  const result: UnifiedLine[] = []
  let unchangedRun = 0, runStart = 0

  const flush = (start: number, count: number) => {
    if (count === 0) return
    if (ctx > 0 && count > ctx * 2 + 2) {
      for (let k = 0; k < ctx; k++) result.push(rawLines.value[start + k])
      result.push({ type: 'ellipsis', text: `... 省略 ${count - ctx * 2} 行 ...` })
      for (let k = count - ctx; k < count; k++) result.push(rawLines.value[start + k])
    } else {
      for (let k = 0; k < count; k++) result.push(rawLines.value[start + k])
    }
  }

  for (let idx = 0; idx < rawLines.value.length; idx++) {
    const line = rawLines.value[idx]
    if (line.type === 'unchanged') {
      if (unchangedRun === 0) runStart = idx
      unchangedRun++
    } else {
      flush(runStart, unchangedRun)
      unchangedRun = 0
      result.push(line)
    }
  }
  flush(runStart, unchangedRun)
  return result
})

// ---- split 模式 ----
interface SplitPair {
  type: 'unchanged' | 'changed' | 'added' | 'removed' | 'ellipsis'
  oldLine?: { num: number; text: string }
  newLine?: { num: number; text: string }
  text?: string
}

const splitPairs = computed<SplitPair[]>(() => {
  if (!rawLines.value.length) return []
  const raw = rawLines.value
  const ctx = props.collapsed ? props.context : 0

  const grouped: { type: 'unchanged' | 'change_group'; lines: RawLine[] }[] = []
  let idx = 0
  while (idx < raw.length) {
    if (raw[idx].type === 'unchanged') {
      const block: RawLine[] = []
      while (idx < raw.length && raw[idx].type === 'unchanged') { block.push(raw[idx]); idx++ }
      grouped.push({ type: 'unchanged', lines: block })
    } else {
      const block: RawLine[] = []
      while (idx < raw.length && raw[idx].type !== 'unchanged') { block.push(raw[idx]); idx++ }
      grouped.push({ type: 'change_group', lines: block })
    }
  }

  const result: SplitPair[] = []
  for (const g of grouped) {
    if (g.type === 'unchanged') {
      const count = g.lines.length
      if (ctx > 0 && count > ctx * 2 + 2) {
        for (let k = 0; k < ctx; k++) {
          const l = g.lines[k]
          result.push({ type: 'unchanged', oldLine: { num: l.oldLineNum!, text: l.text }, newLine: { num: l.newLineNum!, text: l.text } })
        }
        result.push({ type: 'ellipsis', text: `... 省略 ${count - ctx * 2} 行 ...` })
        for (let k = count - ctx; k < count; k++) {
          const l = g.lines[k]
          result.push({ type: 'unchanged', oldLine: { num: l.oldLineNum!, text: l.text }, newLine: { num: l.newLineNum!, text: l.text } })
        }
      } else {
        for (const l of g.lines) {
          result.push({ type: 'unchanged', oldLine: { num: l.oldLineNum!, text: l.text }, newLine: { num: l.newLineNum!, text: l.text } })
        }
      }
    } else {
      const removed: RawLine[] = []
      const added: RawLine[] = []
      for (const l of g.lines) { if (l.type === 'removed') removed.push(l); else added.push(l) }
      const maxLen = Math.max(removed.length, added.length)
      for (let k = 0; k < maxLen; k++) {
        const r = removed[k], a = added[k]
        if (r && a) {
          result.push({ type: 'changed', oldLine: { num: r.oldLineNum!, text: r.text }, newLine: { num: a.newLineNum!, text: a.text } })
        } else if (r) {
          result.push({ type: 'removed', oldLine: { num: r.oldLineNum!, text: r.text } })
        } else if (a) {
          result.push({ type: 'added', newLine: { num: a.newLineNum!, text: a.text } })
        }
      }
    }
  }
  return result
})

// ---- 变更导航 ----
function jumpToChange(dir: 'prev' | 'next') {
  const el = linesContainer.value || splitLeftPane.value
  if (!el) return
  const container = el.closest('.diff-lines, .split-scroll') as HTMLElement
  if (!container) return
  const sel = props.mode === 'unified'
    ? '.diff-line.diff-added, .diff-line.diff-removed'
    : '.diff-row:not(.diff-row-unchanged):not(.diff-row-ellipsis)'
  const rows = el.querySelectorAll(sel)
  if (!rows.length) return

  const currentScroll = container.scrollTop
  let target = dir === 'next' ? 0 : rows.length - 1

  if (dir === 'next') {
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i] as HTMLElement).offsetTop > currentScroll + 10) { target = i; break }
    }
  } else {
    for (let i = rows.length - 1; i >= 0; i--) {
      if ((rows[i] as HTMLElement).offsetTop < currentScroll - 10) { target = i; break }
    }
  }

  ;(rows[target] as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' })
}

defineExpose({ jumpToChange })
</script>

<template>
  <div class="diff-viewer" :class="`diff-mode-${mode}`">
    <!-- unified 模式 -->
    <template v-if="mode === 'unified'">
      <div class="diff-file-header">
        <span class="diff-file old">--- {{ oldLabel }}</span>
        <span class="diff-file new">+++ {{ newLabel }}</span>
      </div>
      <div class="diff-lines">
        <div ref="linesContainer" class="diff-lines-inner">
          <div
            v-for="(line, idx) in unifiedLines"
            :key="idx"
            class="diff-line"
            :class="`diff-${line.type}`"
          >
            <template v-if="line.type === 'unchanged'">
              <span class="ln ln-old">{{ line.oldLineNum }}</span>
              <span class="ln ln-new">{{ line.newLineNum }}</span>
              <span class="line-content">{{ line.text }}</span>
            </template>
            <template v-else-if="line.type === 'added'">
              <span class="ln ln-old"></span>
              <span class="ln ln-new">{{ line.newLineNum }}</span>
              <span class="line-sign">+</span>
              <span class="line-content">{{ line.text }}</span>
            </template>
            <template v-else-if="line.type === 'removed'">
              <span class="ln ln-old">{{ line.oldLineNum }}</span>
              <span class="ln ln-new"></span>
              <span class="line-sign">-</span>
              <span class="line-content">{{ line.text }}</span>
            </template>
            <template v-else-if="line.type === 'ellipsis'">
              <span class="ln ln-old"></span>
              <span class="ln ln-new"></span>
              <span class="line-content ellipsis-text">{{ line.text }}</span>
            </template>
          </div>
          <div v-if="!unifiedLines.length" class="diff-empty">（无差异）</div>
        </div>
      </div>
    </template>

    <!-- split 模式 -->
    <template v-else>
      <div class="diff-file-header split">
        <span class="diff-file old">--- {{ oldLabel }}</span>
        <span class="diff-file new">+++ {{ newLabel }}</span>
      </div>
      <div class="split-wrapper">
        <div ref="splitLeftPane" class="split-scroll" @scroll="onSplitScroll">
          <div class="split-scroll-inner">
            <div
              v-for="(pair, idx) in splitPairs"
              :key="'l'+idx"
              class="diff-split-row"
              :class="`diff-row-${pair.type}`"
            >
              <template v-if="pair.type === 'ellipsis'">
                <span class="ln">·</span>
                <span class="ellipsis-text">{{ pair.text }}</span>
              </template>
              <template v-else-if="pair.oldLine">
                <span class="ln">{{ pair.oldLine.num }}</span>
                <span v-if="pair.type === 'removed' || pair.type === 'changed'" class="line-sign">-</span>
                <span v-else class="line-sign-spacer"></span>
                <span class="line-content">{{ pair.oldLine.text }}</span>
              </template>
              <span v-else class="empty-placeholder">&nbsp;</span>
            </div>
            <div v-if="!splitPairs.length" class="diff-empty">（无差异）</div>
          </div>
        </div>
        <div ref="splitRightPane" class="split-scroll" @scroll="onSplitScroll">
          <div class="split-scroll-inner">
            <div
              v-for="(pair, idx) in splitPairs"
              :key="'r'+idx"
              class="diff-split-row"
              :class="`diff-row-${pair.type}`"
            >
              <template v-if="pair.type === 'ellipsis'">
                <span class="ln">·</span>
                <span class="ellipsis-text">{{ pair.text }}</span>
              </template>
              <template v-else-if="pair.newLine">
                <span class="ln">{{ pair.newLine.num }}</span>
                <span v-if="pair.type === 'added' || pair.type === 'changed'" class="line-sign">+</span>
                <span v-else class="line-sign-spacer"></span>
                <span class="line-content">{{ pair.newLine.text }}</span>
              </template>
              <span v-else class="empty-placeholder">&nbsp;</span>
            </div>
            <div v-if="!splitPairs.length" class="diff-empty">（无差异）</div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.diff-viewer {
  font-family: var(--font-mono), 'Consolas', 'Courier New', monospace;
  font-size: 0.78rem;
  line-height: 1.55;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  display: flex; flex-direction: column;
}

.diff-file-header {
  display: flex; gap: 16px;
  padding: 6px 12px;
  background: var(--bg-inset);
  border-bottom: 1px solid var(--border);
  font-size: 0.72rem; font-weight: 600;
  flex-shrink: 0;
}
.diff-file.old { color: #c62828; }
.diff-file.new { color: #2e7d32; }
.diff-file-header.split { justify-content: space-between; }

/* ---- shared ---- */
.ln {
  display: inline-block; width: 44px; min-width: 44px;
  text-align: right; padding-right: 8px;
  color: var(--text-muted); user-select: none;
  font-size: 0.72rem;
}
.line-sign {
  display: inline-block; width: 16px; min-width: 16px;
  text-align: center; font-weight: 700; user-select: none;
}
.line-sign-spacer { display: inline-block; width: 16px; min-width: 16px; }
.line-content { padding-left: 4px; white-space: pre; }
.ellipsis-text { color: var(--text-muted); font-style: italic; padding: 2px 8px; user-select: none; white-space: nowrap; }
.diff-empty { padding: 24px; text-align: center; color: var(--text-muted); }
.empty-placeholder { flex: 1; white-space: pre; }
.empty-placeholder::after { content: '\00a0'; }

/* ---- unified ---- */
.diff-lines {
  flex: 1; overflow: auto;
}
.diff-lines-inner {
  display: inline-block; min-width: 100%;
}
.diff-line {
  display: flex; align-items: baseline;
  min-height: 1.55em;
}
.diff-line .ln { position: sticky; z-index: 1; }
.diff-line .ln.ln-old { left: 0; }
.diff-line .ln.ln-new { left: 44px; }
.diff-line .line-sign { position: sticky; left: 88px; z-index: 1; }
.diff-line.diff-unchanged .ln { background: #fff; }
.diff-line.diff-added { background: #e6ffec; }
.diff-line.diff-added .ln,
.diff-line.diff-added .line-sign { background: #ccffd8; }
.diff-line.diff-removed { background: #ffebe9; }
.diff-line.diff-removed .ln,
.diff-line.diff-removed .line-sign { background: #ffd7d5; }
.diff-line.diff-ellipsis { background: #f0f4ff; }
.diff-line.diff-ellipsis .ln { background: #f0f4ff; }
.diff-added .line-sign { color: #1a7f37; }
.diff-removed .line-sign { color: #cf222e; }

/* ---- split ---- */
.split-wrapper {
  display: flex; flex: 1; overflow: hidden;
}
.split-scroll {
  flex: 1; overflow: auto; min-width: 0;
}
.split-scroll-inner {
  display: inline-block; min-width: 100%;
}
.diff-split-row {
  display: flex; align-items: baseline;
  min-height: 1.55em;
}
.diff-split-row .ln { position: sticky; left: 0; z-index: 1; flex-shrink: 0; }
.diff-split-row .line-sign,
.diff-split-row .line-sign-spacer { position: sticky; left: 44px; z-index: 1; flex-shrink: 0; }

.diff-row-unchanged { background: #fff; }
.diff-row-unchanged .ln,
.diff-row-unchanged .line-sign-spacer { background: #fff; }
.diff-row-removed { background: #ffebe9; }
.diff-row-removed .ln,
.diff-row-removed .line-sign,
.diff-row-removed .line-sign-spacer { background: #ffd7d5; }
.diff-row-added { background: #e6ffec; }
.diff-row-added .ln,
.diff-row-added .line-sign,
.diff-row-added .line-sign-spacer { background: #ccffd8; }
.diff-row-changed { background: #ffebe9; }
.diff-row-changed .ln,
.diff-row-changed .line-sign,
.diff-row-changed .line-sign-spacer { background: #ffd7d5; }
.diff-row-ellipsis { background: #f0f4ff; }
.diff-row-ellipsis .ln { background: #f0f4ff; }

.diff-split-row .line-sign { color: #cf222e; }
.diff-row-added .line-sign,
.diff-row-changed .line-sign { color: #1a7f37; }

/* 右侧 pane 用不同的 sticky left 偏移 */
.split-wrapper > :last-child .diff-split-row .ln { left: 0; }
.split-wrapper > :last-child .diff-split-row .line-sign,
.split-wrapper > :last-child .diff-split-row .line-sign-spacer { left: 44px; }
</style>
