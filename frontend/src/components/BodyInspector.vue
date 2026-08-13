<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import JsonViewer from './JsonViewer.vue'
import {
  defaultBodyTab,
  formatPrettyJson,
  presentBody,
  type BodyContentTab,
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
  /** 协议合并结果（AI 响应体）；非空则出现「合并」tab */
  mergedText?: string | null
  /** 即使 mergedText 为空也显示「合并」tab（AI 路径） */
  enableMerged?: boolean
}>(), {
  open: false,
  showEmpty: false,
  enableMerged: false,
})

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

type Tab = BodyContentTab | 'merged'

const presentation = computed(() => presentBody(props.body, props.contentType))

const tabs = computed<Tab[]>(() => {
  const list: Tab[] = [...presentation.value.contentTabs]
  if (props.enableMerged || (props.mergedText != null && props.mergedText !== '')) {
    if (!list.includes('merged')) list.push('merged')
  }
  return list
})

const activeTab = ref<Tab>('raw')
/** 按需美化缓存（大 body 首次点「美化」时生成） */
const lazyPretty = ref<string | null>(null)
const prettyError = ref<string | null>(null)
const prettyLoading = ref(false)

function pickDefaultTab(available: Tab[]): Tab {
  const contentOnly = available.filter((tab): tab is BodyContentTab => tab !== 'merged')
  const preferred = defaultBodyTab(contentOnly, presentation.value.defaultTab)
  if (available.includes(preferred)) return preferred
  return available[0] ?? 'raw'
}

watch(
  () => [props.body, props.contentType, props.enableMerged, props.mergedText] as const,
  () => {
    lazyPretty.value = null
    prettyError.value = null
    prettyLoading.value = false
    activeTab.value = pickDefaultTab(tabs.value)
  },
  { immediate: true },
)

const displayPretty = computed(() => presentation.value.prettyText ?? lazyPretty.value)

watch(activeTab, (tab) => {
  if (tab !== 'pretty') return
  if (displayPretty.value != null) return
  if (!presentation.value.canPretty) return
  prettyLoading.value = true
  prettyError.value = null
  // 下一帧再 parse，避免挡住 tab 切换绘制
  requestAnimationFrame(() => {
    const text = formatPrettyJson(presentation.value.rawText)
    if (text == null) {
      prettyError.value = '美化失败：不是合法 JSON'
      lazyPretty.value = null
    } else {
      lazyPretty.value = text
    }
    prettyLoading.value = false
  })
})

function tabLabel(tab: Tab): string {
  switch (tab) {
    case 'raw': return '原始'
    case 'pretty': return '美化'
    case 'fields': return '字段'
    case 'merged': return '合并'
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

      <div v-if="tabs.length > 1" class="rb-tabs">
        <button
          v-for="tab in tabs"
          :key="tab"
          type="button"
          class="rb-tab"
          :class="{ active: activeTab === tab }"
          @click="activeTab = tab"
        >{{ tabLabel(tab) }}</button>
      </div>

      <div v-if="open" class="rb-pane">
        <template v-if="activeTab === 'fields' && presentation.formFields">
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
        <p v-else-if="activeTab === 'pretty' && prettyLoading" class="bi-empty">正在美化…</p>
        <p v-else-if="activeTab === 'pretty' && prettyError" class="bi-empty">{{ prettyError }}</p>
        <JsonViewer
          v-else-if="activeTab === 'pretty' && displayPretty"
          :value="displayPretty"
          lang="json"
        />
        <JsonViewer
          v-else-if="activeTab === 'merged'"
          :value="mergedText || ''"
          lang="json"
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
