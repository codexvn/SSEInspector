<script setup lang="ts">
/**
 * 共享 Markdown 渲染面：markdown-it + KaTeX + Mermaid + DOMPurify 消毒。
 * 从 BaseTextCard 抽出，供消息卡片与正文块的「Markdown」查看器共用，
 * 保证两种场景的渲染行为（数学、图表、链接、安全消毒）完全一致。
 */
import { computed, nextTick, ref, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import markdownItKatex from 'markdown-it-katex'
import DOMPurify from 'dompurify'
import mermaid from 'mermaid'
import 'katex/dist/katex.min.css'
import { formatErrorChain } from '../error'

const props = withDefaults(defineProps<{
  text?: string
}>(), {
  text: '',
})

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

const renderedHtml = computed(() =>
  DOMPurify.sanitize(markdown.render(props.text ?? ''), {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
  }),
)

async function renderMermaidBlocks() {
  await nextTick()
  const root = contentRef.value
  if (!root) return

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
      console.warn(`[MarkdownRender] Mermaid 渲染失败: ${formatErrorChain(err)}`)
      pre.classList.add('mermaid-error')
      pre.setAttribute('title', `Mermaid 渲染失败: ${(err as Error).message}`)
    }
  }
}

watch(() => props.text, renderMermaidBlocks, { immediate: true })
</script>

<template>
  <div ref="contentRef" class="markdown-render markdown-body" v-html="renderedHtml"></div>
</template>

<style scoped>
.markdown-render {
  padding: 16px 18px;
  /* 与 BaseTextCard 正文同宽的阅读上限，保证渲染态与原文态行宽一致 */
  max-width: 880px;
  font-size: 0.9rem;
  line-height: 1.7;
  color: var(--text-primary);
  min-width: 0;
}

.markdown-render :deep(p) {
  margin: 0 0 0.75em;
}
.markdown-render :deep(p:last-child) {
  margin-bottom: 0;
}
.markdown-render :deep(pre) {
  margin: 10px 0;
  padding: 12px 14px;
  overflow: auto;
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.82rem;
}
.markdown-render :deep(code) {
  font-family: var(--font-mono);
  word-break: break-word;
}
.markdown-render :deep(:not(pre) > code) {
  background: var(--bg-inset);
  border-radius: 4px;
  padding: 1px 5px;
}
.markdown-render :deep(table) {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow: auto;
  border-collapse: collapse;
}
.markdown-render :deep(th),
.markdown-render :deep(td) {
  border: 1px solid var(--border);
  padding: 6px 10px;
}
.markdown-render :deep(a) {
  color: var(--accent);
  word-break: break-all;
}
.markdown-render :deep(.markdown-mermaid) {
  overflow: auto;
  padding: 12px;
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
}
.markdown-render :deep(.mermaid-error) {
  border: 1px solid var(--warning);
}
</style>
