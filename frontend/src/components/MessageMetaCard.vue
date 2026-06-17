<script setup lang="ts">
defineProps<{
  model?: string
  endpoint?: string
  stream?: boolean
  maxTokens?: unknown
  temperature?: unknown
  toolChoice?: unknown
  parallelToolCalls?: unknown
}>()
</script>

<template>
  <div class="message-meta-card">
    <span v-if="model">model: {{ model }}</span>
    <span v-if="endpoint">endpoint: {{ endpoint }}</span>
    <span v-if="stream !== undefined">stream: {{ stream ? 'true' : 'false' }}</span>
    <span v-if="maxTokens !== undefined">max_tokens: {{ maxTokens }}</span>
    <span v-if="temperature !== undefined">temperature: {{ temperature }}</span>
    <span v-if="toolChoice !== undefined">tool_choice: {{ JSON.stringify(toolChoice) }}</span>
    <span v-if="parallelToolCalls !== undefined">parallel_tool_calls: {{ parallelToolCalls }}</span>
  </div>
</template>

<style scoped>
.message-meta-card {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  background: var(--bg-card);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  padding: 12px 16px;
  margin-bottom: 12px;
  border-left: 4px solid #ff9800;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--text-secondary);
}
</style>
