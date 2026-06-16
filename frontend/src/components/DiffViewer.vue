<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  oldString: string
  newString: string
  oldLabel?: string
  newLabel?: string
  /** 'unified'=单栏, 'split'=双栏 */
  mode?: 'unified' | 'split'
  /** 未变更行前后各保留多少行上下文。0 = 展开全部 */
  context?: number
  /** 是否折叠（收起）长未变更块，false 时 context 被忽略 */
  collapsed?: boolean
}>(), {
  oldLabel: '旧',
  newLabel: '新',
  mode: 'unified',
  context: 3,
  collapsed: true,
})

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

// ---- unified 模式（带折叠） ----
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

// ---- split 模式（左右配对） ----
interface SplitPair {
  type: 'unchanged' | 'changed' | 'added' | 'removed' | 'ellipsis'
  oldLine?: { num: number; text: string }
  newLine?: { num: number; text: string }
  text?: string // for ellipsis
}

const splitPairs = computed<SplitPair[]>(() => {
  if (!rawLines.value.length) return []
  const raw = rawLines.value
  const ctx = props.collapsed ? props.context : 0

  // Group into unchanged / change_group blocks
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
          result.push({
            type: 'unchanged',
            oldLine: { num: l.oldLineNum!, text: l.text },
            newLine: { num: l.newLineNum!, text: l.text },
          })
        }
        result.push({ type: 'ellipsis', text: `... 省略 ${count - ctx * 2} 行 ...` })
        for (let k = count - ctx; k < count; k++) {
          const l = g.lines[k]
          result.push({
            type: 'unchanged',
            oldLine: { num: l.oldLineNum!, text: l.text },
            newLine: { num: l.newLineNum!, text: l.text },
          })
        }
      } else {
        for (const l of g.lines) {
          result.push({
            type: 'unchanged',
            oldLine: { num: l.oldLineNum!, text: l.text },
            newLine: { num: l.newLineNum!, text: l.text },
          })
        }
      }
    } else {
      // change_group: pair removed + added 1:1
      const removed: RawLine[] = []
      const added: RawLine[] = []
      for (const l of g.lines) {
        if (l.type === 'removed') removed.push(l)
        else added.push(l)
      }
      const maxLen = Math.max(removed.length, added.length)
      for (let k = 0; k < maxLen; k++) {
        const r = removed[k]
        const a = added[k]
        if (r && a) {
          result.push({
            type: 'changed',
            oldLine: { num: r.oldLineNum!, text: r.text },
            newLine: { num: a.newLineNum!, text: a.text },
          })
        } else if (r) {
          result.push({
            type: 'removed',
            oldLine: { num: r.oldLineNum!, text: r.text },
          })
        } else if (a) {
          result.push({
            type: 'added',
            newLine: { num: a.newLineNum!, text: a.text },
          })
        }
      }
    }
  }
  return result
})
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
    </template>

    <!-- split 模式 -->
    <template v-else>
      <div class="diff-file-header split">
        <span class="diff-file old">--- {{ oldLabel }}</span>
        <span class="diff-file new">+++ {{ newLabel }}</span>
      </div>
      <div class="diff-lines split-lines">
        <div
          v-for="(pair, idx) in splitPairs"
          :key="idx"
          class="diff-row"
          :class="`diff-row-${pair.type}`"
        >
          <!-- 左侧（旧） -->
          <div class="diff-pane old-pane" :class="{ empty: !pair.oldLine }">
            <template v-if="pair.type === 'ellipsis'">
              <span class="ellipsis-text">{{ pair.text }}</span>
            </template>
            <template v-else-if="pair.oldLine">
              <span class="ln">{{ pair.oldLine.num }}</span>
              <span v-if="pair.type === 'removed' || pair.type === 'changed'" class="line-sign">-</span>
              <span v-else class="line-sign-spacer"></span>
              <span class="line-content">{{ pair.oldLine.text }}</span>
            </template>
          </div>
          <!-- 分隔线 -->
          <div class="diff-gutter"></div>
          <!-- 右侧（新） -->
          <div class="diff-pane new-pane" :class="{ empty: !pair.newLine }">
            <template v-if="pair.type === 'ellipsis'">
              <span class="ellipsis-text">{{ pair.text }}</span>
            </template>
            <template v-else-if="pair.newLine">
              <span class="ln">{{ pair.newLine.num }}</span>
              <span v-if="pair.type === 'added' || pair.type === 'changed'" class="line-sign">+</span>
              <span v-else class="line-sign-spacer"></span>
              <span class="line-content">{{ pair.newLine.text }}</span>
            </template>
          </div>
        </div>
        <div v-if="!splitPairs.length" class="diff-empty">（无差异）</div>
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
  overflow: auto;
}

.diff-file-header {
  display: flex; gap: 16px;
  padding: 6px 12px;
  background: var(--bg-inset);
  border-bottom: 1px solid var(--border);
  font-size: 0.72rem; font-weight: 600;
  position: sticky; top: 0; z-index: 1;
}
.diff-file.old { color: #c62828; }
.diff-file.new { color: #2e7d32; }
.diff-file-header.split {
  justify-content: space-between;
}

/* ---- unified ---- */
.diff-lines { overflow: auto; }

.diff-line {
  display: flex; align-items: baseline;
  min-height: 1.55em; white-space: pre;
}
.diff-line.diff-added { background: #e6ffec; }
.diff-line.diff-removed { background: #ffebe9; }
.diff-line.diff-ellipsis { background: #f0f4ff; }

.ln {
  display: inline-block; width: 44px; min-width: 44px;
  text-align: right; padding-right: 8px;
  color: var(--text-muted); user-select: none;
  font-size: 0.72rem; flex-shrink: 0;
}
.diff-added .ln { background: #ccffd8; }
.diff-removed .ln { background: #ffd7d5; }

.line-sign {
  width: 16px; min-width: 16px; text-align: center; flex-shrink: 0;
  font-weight: 700; user-select: none;
}
.diff-added .line-sign { color: #1a7f37; }
.diff-removed .line-sign { color: #cf222e; }
.line-sign-spacer { width: 16px; min-width: 16px; flex-shrink: 0; }

.line-content { padding-left: 4px; }

.ellipsis-text {
  color: var(--text-muted); font-style: italic;
  padding: 2px 8px; user-select: none;
}

.diff-empty {
  padding: 24px; text-align: center; color: var(--text-muted);
}

/* ---- split ---- */
.split-lines { overflow: auto; }

.diff-row {
  display: flex; min-height: 1.55em;
}
.diff-row.diff-row-changed,
.diff-row.diff-row-added,
.diff-row.diff-row-removed {
  min-height: 1.55em;
}
.diff-pane {
  flex: 1; min-width: 0;
  display: flex; align-items: baseline;
  white-space: pre; overflow: hidden;
}
.diff-pane.empty { background: #fafbfc; }

.old-pane { border-right: none; }
.diff-pane .ln { flex-shrink: 0; }
.diff-pane .line-content { overflow: hidden; text-overflow: ellipsis; }

.diff-row-removed .old-pane { background: #ffebe9; }
.diff-row-added .new-pane { background: #e6ffec; }
.diff-row-changed .old-pane { background: #ffebe9; }
.diff-row-changed .new-pane { background: #e6ffec; }
.diff-row-ellipsis { background: #f0f4ff; }

.old-pane .line-sign { color: #cf222e; }
.new-pane .line-sign { color: #1a7f37; }

.diff-gutter {
  width: 1px; background: var(--border); flex-shrink: 0;
}
</style>
