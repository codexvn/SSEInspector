<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import markdownItKatex from 'markdown-it-katex'
import DOMPurify from 'dompurify'
import mermaid from 'mermaid'
import 'katex/dist/katex.min.css'

const props = withDefaults(defineProps<{
  title: string
  text?: string
  tone?: 'system' | 'user' | 'assistant' | 'thinking'
  markdown?: boolean
  defaultRaw?: boolean
}>(), {
  text: '',
  tone: 'assistant',
  markdown: true,
  defaultRaw: false,
})

const showRaw = ref(props.defaultRaw)
const contentRef = ref<HTMLElement | null>(null)

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: true,
}).use(markdownItKatex)

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'default',
})

const renderedHtml = computed(() => {
  if (!props.markdown) return ''
  return DOMPurify.sanitize(markdown.render(props.text ?? ''), {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
  })
})

async function renderMermaidBlocks() {
  await nextTick()
  const root = contentRef.value
  if (!root || showRaw.value || !props.markdown) return

  const blocks = Array.from(root.querySelectorAll('pre > code.language-mermaid'))
  for (const block of blocks) {
    const source = block.textContent ?? ''
    const pre = block.parentElement
    if (!source.trim() || !pre) continue

    try {
      const id = `mermaid-${crypto.randomUUID()}`
      const { svg } = await mermaid.render(id, source)
      const wrapper = document.createElement('div')
      wrapper.className = 'markdown-mermaid'
      wrapper.innerHTML = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
      })
      pre.replaceWith(wrapper)
    } catch (err) {
      pre.classList.add('mermaid-error')
      pre.setAttribute('title', `Mermaid 渲染失败: ${(err as Error).message}`)
    }
  }
}

watch(() => [props.text, props.markdown, showRaw.value], renderMermaidBlocks, { immediate: true })
</script>

<template>
  <div class="text-card" :class="`tone-${tone}`">
    <div class="text-card-header">
      <span class="text-card-title">{{ title }}</span>
      <button class="text-card-toggle" type="button" @click="showRaw = !showRaw">
        {{ showRaw ? '渲染' : '原文' }}
      </button>
    </div>
    <pre v-if="showRaw || !markdown" class="text-card-raw">{{ text }}</pre>
    <div v-else ref="contentRef" class="text-card-content markdown-body" v-html="renderedHtml"></div>
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

.text-card-content,
.text-card-raw {
  padding: 16px 18px;
  font-size: 0.9rem;
  line-height: 1.7;
  color: var(--text-primary);
  min-width: 0;
}

.text-card-raw {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono);
}

.tone-system { border-left-color: #9e9e9e; }
.tone-system .text-card-title { color: #616161; }
.tone-user { border-left-color: #ab47bc; }
.tone-user .text-card-title { color: #7b1fa2; }
.tone-assistant { border-left-color: #66bb6a; }
.tone-assistant .text-card-title { color: #2e7d32; }
.tone-thinking { border-left-color: #42a5f5; }
.tone-thinking .text-card-title { color: #1565c0; }

.markdown-body :deep(p) {
  margin: 0 0 0.75em;
}

.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(pre) {
  margin: 10px 0;
  padding: 12px 14px;
  overflow: auto;
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.82rem;
}

.markdown-body :deep(code) {
  font-family: var(--font-mono);
  word-break: break-word;
}

.markdown-body :deep(:not(pre) > code) {
  background: var(--bg-inset);
  border-radius: 4px;
  padding: 1px 5px;
}

.markdown-body :deep(table) {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow: auto;
  border-collapse: collapse;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--border);
  padding: 6px 10px;
}

.markdown-body :deep(a) {
  color: var(--accent);
  word-break: break-all;
}

.markdown-body :deep(.markdown-mermaid) {
  overflow: auto;
  padding: 12px;
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
}

.markdown-body :deep(.mermaid-error) {
  border: 1px solid var(--warning);
}
</style>
