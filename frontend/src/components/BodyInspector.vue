<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import JsonViewer from './JsonViewer.vue'
import MarkdownRender from './MarkdownRender.vue'
import {
  defaultBodyViewer,
  formatPrettyJson,
  formatPrettyXml,
  presentBody,
  type BodyViewer,
} from '../body-presentation'

const props = withDefaults(defineProps<{
  title: string
  body: unknown
  contentType?: string | null
  /** 折叠区标题旁摘要（如 AI 请求体 model/stream 摘要） */
  summary?: string
  /** 受控展开 */
  open?: boolean
  /** 是否展示空 body 占位；默认 false 时 empty 不渲染 */
  showEmpty?: boolean
  /** 协议合并结果（AI 响应体）；非空时 JSON 查看器展示合并结果而非原始体 */
  mergedText?: string | null
  /** 即使 mergedText 为空也启用 JSON 查看器展示合并结果（AI 路径） */
  enableMerged?: boolean
}>(), {
  open: false,
  showEmpty: false,
  enableMerged: false,
})

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const presentation = computed(() => presentBody(props.body, props.contentType))

/** AI 响应路径：有合并结果时查看器固定为 原始 + JSON（JSON 即合并结果的格式化视图） */
const mergedMode = computed(() => props.enableMerged || (props.mergedText != null && props.mergedText !== ''))

const viewers = computed<BodyViewer[]>(() => {
  if (mergedMode.value) return ['raw', 'json']
  return presentation.value.viewers
})

const activeViewer = ref<BodyViewer>('raw')
/** 按需格式化缓存（大 body 首次切到对应查看器时生成） */
const lazyJson = ref<string | null>(null)
const lazyXml = ref<string | null>(null)
const lazyError = ref<string | null>(null)
const lazyLoading = ref(false)

watch(
  () => [props.body, props.contentType, props.enableMerged, props.mergedText] as const,
  () => {
    lazyJson.value = null
    lazyXml.value = null
    lazyError.value = null
    lazyLoading.value = false
    activeViewer.value = mergedMode.value
      ? 'json'
      : defaultBodyViewer(viewers.value, presentation.value.defaultViewer)
  },
  { immediate: true },
)

const displayJson = computed(() => {
  if (mergedMode.value) return props.mergedText || ''
  return presentation.value.prettyJson ?? lazyJson.value
})

const displayXml = computed(() => presentation.value.prettyXml ?? lazyXml.value)

watch(activeViewer, (viewer) => {
  if (viewer === 'json' && !mergedMode.value) {
    if (displayJson.value != null || !presentation.value.canPrettyJson) return
    prepareLazy(() => {
      const text = formatPrettyJson(presentation.value.rawText)
      if (text == null) lazyError.value = 'JSON 格式化失败：不是合法 JSON'
      else lazyJson.value = text
    })
  }
  if (viewer === 'xml') {
    if (displayXml.value != null) return
    prepareLazy(() => {
      const text = formatPrettyXml(presentation.value.rawText)
      if (text == null) lazyError.value = 'XML 格式化失败：内容不含标签'
      else lazyXml.value = text
    })
  }
})

/** 下一帧再格式化，避免挡住查看器切换绘制 */
function prepareLazy(format: () => void): void {
  if (lazyLoading.value) return
  lazyLoading.value = true
  lazyError.value = null
  requestAnimationFrame(() => {
    format()
    lazyLoading.value = false
  })
}

function viewerLabel(viewer: BodyViewer): string {
  switch (viewer) {
    case 'raw': return '原始'
    case 'json': return 'JSON'
    case 'xml': return 'XML'
    case 'markdown': return 'Markdown'
    case 'fields': return '字段'
  }
}

function onToggle(event: Event) {
  emit('update:open', (event.currentTarget as HTMLDetailsElement).open)
}

const visible = computed(() => {
  if (!presentation.value.empty) return true
  return props.showEmpty
})
</script>

<template>
  <details
    v-if="visible"
    class="body-inspector"
    :open="open"
    @toggle="onToggle"
  >
    <summary>
      <span class="bi-summary-row">
        <span class="bi-title">{{ title }}</span>
        <span v-if="!presentation.empty" class="bi-kind">{{ presentation.kindLabel }}</span>
        <span v-if="summary" class="bi-summary">{{ summary }}</span>
        <span class="bi-actions" @click.stop>
          <slot name="actions" />
        </span>
      </span>
    </summary>

    <p v-if="presentation.empty" class="bi-empty">无请求体</p>
    <template v-else>
      <p v-if="presentation.note" class="bi-note">{{ presentation.note }}</p>

      <div v-if="viewers.length > 1" class="rb-tabs">
        <button
          v-for="viewer in viewers"
          :key="viewer"
          type="button"
          class="rb-tab"
          :class="{ active: activeViewer === viewer }"
          @click="activeViewer = viewer"
        >{{ viewerLabel(viewer) }}</button>
      </div>

      <div v-if="open" class="rb-pane">
        <p v-if="lazyLoading" class="bi-empty">正在格式化…</p>
        <p v-else-if="lazyError" class="bi-empty">{{ lazyError }}</p>
        <template v-else-if="activeViewer === 'fields' && presentation.formFields">
          <table class="bi-form-table">
            <thead>
              <tr><th>字段</th><th>值</th></tr>
            </thead>
            <tbody>
              <tr v-for="(field, index) in presentation.formFields" :key="`${field.key}-${index}`">
                <td class="bi-form-key">{{ field.key }}</td>
                <td class="bi-form-val">{{ field.value }}</td>
              </tr>
            </tbody>
          </table>
        </template>
        <JsonViewer
          v-else-if="activeViewer === 'json' && displayJson"
          :value="displayJson"
          lang="json"
        />
        <JsonViewer
          v-else-if="activeViewer === 'xml' && displayXml"
          :value="displayXml"
          lang="xml"
        />
        <MarkdownRender
          v-else-if="activeViewer === 'markdown'"
          :text="presentation.rawText"
        />
        <JsonViewer
          v-else
          :value="presentation.rawText"
          :lang="presentation.monacoLang"
        />
      </div>
    </template>
  </details>
</template>

<style scoped>
.body-inspector {
  background: var(--bg-card);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  margin-bottom: 12px;
  padding: 0;
}
/* 与 HeadersViewer 一致：保留浏览器原生 ▶，内容用内层 flex 排版 */
.body-inspector summary {
  cursor: pointer;
  padding: 12px 18px;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-secondary);
  user-select: none;
  position: relative;
}
.bi-summary-row {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  width: calc(100% - 1em);
  vertical-align: middle;
}
.bi-title { color: var(--text-secondary); }
.bi-kind {
  font-size: 0.68rem;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--bg-inset);
  color: var(--text-muted);
  border: 1px solid var(--border);
  text-transform: none;
  letter-spacing: 0;
}
.bi-summary {
  font-weight: 400;
  color: var(--text-muted);
  font-size: 0.76rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 48%;
}
.bi-actions {
  margin-left: auto;
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.bi-note {
  margin: 0;
  padding: 0 18px 10px;
  font-size: 0.76rem;
  color: var(--text-muted);
  line-height: 1.45;
}
.bi-empty {
  margin: 0;
  padding: 8px 18px 14px;
  font-size: 0.82rem;
  color: var(--text-muted);
}
.rb-tabs {
  display: flex;
  gap: 4px;
  padding: 0 14px 8px;
  border-bottom: 1px solid var(--border);
}
.rb-tab {
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  font-size: 0.76rem;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.rb-tab:hover { background: var(--bg-inset); color: var(--text-secondary); }
.rb-tab.active {
  background: #e0e7ff;
  border-color: #c7d2fe;
  color: #3730a3;
}
.rb-pane { padding: 8px 10px 12px; }
.bi-form-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}
.bi-form-table th {
  text-align: left;
  padding: 6px 10px;
  background: var(--bg-inset);
  color: var(--text-muted);
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.bi-form-table td {
  padding: 8px 10px;
  border-top: 1px solid var(--border);
  vertical-align: top;
  word-break: break-word;
}
.bi-form-key {
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--text-secondary);
  width: 28%;
  white-space: nowrap;
}
.bi-form-val {
  font-family: var(--font-mono);
  color: var(--text-primary);
  white-space: pre-wrap;
}
</style>
