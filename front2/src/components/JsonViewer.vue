<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useMonaco } from '../composables/useMonaco'

const props = defineProps<{ value: string; lang?: string }>()
const container = ref<HTMLElement | null>(null)
const { create } = useMonaco()

onMounted(async () => {
  if (container.value) await create(container.value, props.value, props.lang ?? 'json')
})
</script>

<template>
  <div ref="container" class="monaco-box"></div>
</template>

<style scoped>
.monaco-box { min-height: 60px; border-radius: var(--radius-sm); }
</style>
