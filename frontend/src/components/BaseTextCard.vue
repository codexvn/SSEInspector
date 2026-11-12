<script setup lang="ts">
import { ref } from 'vue'
import MarkdownRender from './MarkdownRender.vue'

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

const showRaw = ref(props.defaultRaw)
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
