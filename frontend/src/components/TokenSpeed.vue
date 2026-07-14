<script setup lang="ts">
import { computed } from 'vue'
import { formatTokenSpeed } from '../token-speed'

const props = defineProps<{
  state: 'streaming' | 'done' | 'error'
  outputTokens?: number
  durationMs?: number
}>()

const speedText = computed(() => formatTokenSpeed(props.state, props.outputTokens, props.durationMs))
</script>

<template>
  <span class="token-speed">{{ speedText }}</span>
</template>

<style scoped>
.token-speed {
  font-family: var(--font-mono); font-size: 0.78rem; color: var(--accent);
  white-space: nowrap;
}
</style>
