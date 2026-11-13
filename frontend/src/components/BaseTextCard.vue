<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import MarkdownRender from './MarkdownRender.vue'
import JsonViewer from './JsonViewer.vue'
import { formatPrettyJson, formatPrettyXml, MAX_PRETTY_BODY_CHARS } from '../body-presentation'

/**
 * 通用消息卡片：按内容自动提供查看器。模型输出本身是结构化数据
 * （JSON/XML 字符串，如结构化标注、工具结果）时默认展示对应的格式化
 * 视图；普通文本保持 Markdown 渲染 / 原文两态。
 */
const props = withDefaults(defineProps<{
  title: string
  text?: string
  tone?: 'system' | 'user' | 'assistant' | 'thinking' | 'refusal'
  markdown?: boolean
  defaultRaw?: boolean
}>(), {
  text: '',
  tone: 'assistant',
  markdown: true,
  defaultRaw: false,
})

type CardViewer = 'render' | 'json' | 'xml' | 'raw'

const oversized = computed(() => (props.text ?? '').length > MAX_PRETTY_BODY_CHARS)

// 只把对象/数组形态的文本视为结构化输出：裸数字、布尔等普通消息不触发 JSON 视图。
// 解析与格式化只做一次：formatPrettyJson 返回 null 即非 JSON，isJson 由其派生
const prettyJson = computed(() => {
  const text = (props.text ?? '').trimStart()
  if (!text.startsWith('{') && !text.startsWith('[')) return null
  if (oversized.value) return null
  return formatPrettyJson(props.text ?? '')
})
const isJson = computed(() => prettyJson.value != null)

const isXml = computed(() => {
  const text = (props.text ?? '').trimStart()
  if (!text.startsWith('<')) return false
  if (oversized.value) return false
  return !isJson.value && formatPrettyXml(props.text ?? '') != null
})

const prettyXml = computed(() => (isXml.value ? formatPrettyXml(props.text ?? '') : null))

const viewers = computed<CardViewer[]>(() => {
  const list: CardViewer[] = []
  if (isJson.value) list.push('json')
  if (isXml.value) list.push('xml')
  if (props.markdown) list.push('render')
  list.push('raw')
  return list
})

const activeViewer = ref<CardViewer>('raw')

function pickDefault(): CardViewer {
  if (props.defaultRaw) return 'raw'
  if (isJson.value) return 'json'
  if (isXml.value) return 'xml'
  return props.markdown ? 'render' : 'raw'
}

watch(
  () => [props.text, props.markdown] as const,
  () => { activeViewer.value = pickDefault() },
  { immediate: true },
)

function viewerLabel(viewer: CardViewer): string {
  switch (viewer) {
    case 'render': return '渲染'
    case 'json': return 'JSON'
    case 'xml': return 'XML'
    case 'raw': return '原文'
  }
}
</script>

<template>
  <div class="text-card" :class="`tone-${tone}`">
    <div class="text-card-header">
      <span class="text-card-title">{{ title }}</span>
      <span v-if="viewers.length > 1" class="text-card-viewers">
        <button
          v-for="viewer in viewers"
          :key="viewer"
          type="button"
          class="text-card-toggle"
          :class="{ active: activeViewer === viewer }"
          @click="activeViewer = viewer"
        >{{ viewerLabel(viewer) }}</button>
      </span>
    </div>
    <pre v-if="activeViewer === 'raw'" class="text-card-raw">{{ text }}</pre>
    <JsonViewer
      v-else-if="activeViewer === 'json' && prettyJson"
      :value="prettyJson"
      lang="json"
    />
    <JsonViewer
      v-else-if="activeViewer === 'xml' && prettyXml"
      :value="prettyXml"
      lang="xml"
    />
    <MarkdownRender v-else :text="text" />
  </div>
</template>

<style scoped>
.text-card {
  background: var(--bg-card);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  margin-bottom: 12px;
  border-left: 4px solid var(--border);
  min-width: 0;
}
.text-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-inset);
}
.text-card-title {
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.text-card-viewers {
  display: inline-flex;
  gap: 4px;
}
.text-card-toggle {
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  padding: 3px 8px;
  cursor: pointer;
  font-size: 0.72rem;
}
.text-card-toggle:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.text-card-toggle.active {
  background: #e0e7ff;
  border-color: #c7d2fe;
  color: #3730a3;
}
.text-card-raw {
  margin: 0;
  padding: 16px 18px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono);
  font-size: 0.9rem;
  line-height: 1.7;
  color: var(--text-primary);
}

.tone-system { border-left-color: #9e9e9e; }
.tone-system .text-card-title { color: #616161; }
.tone-user { border-left-color: #ab47bc; }
.tone-user .text-card-title { color: #7b1fa2; }
.tone-assistant { border-left-color: #66bb6a; }
.tone-assistant .text-card-title { color: #2e7d32; }
.tone-thinking { border-left-color: #42a5f5; }
.tone-thinking .text-card-title { color: #1565c0; }
.tone-refusal { border-left-color: #ef5350; }
.tone-refusal .text-card-title { color: #c62828; }
</style>
