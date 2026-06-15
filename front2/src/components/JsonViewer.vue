<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useMonaco } from '../composables/useMonaco'

const props = defineProps<{ value: string; lang?: string }>()
const container = ref<HTMLElement | null>(null)
const { create } = useMonaco()

async function render() {
  if (container.value) await create(container.value, props.value, props.lang ?? 'json')
}

onMounted(render)
// 导航切换上下条时 Vue 复用组件不重新 mount，需手动同步 editor 内容
watch(() => props.value, render)
</script>

<template>
  <div ref="container" class="monaco-box"></div>
</template>

<style scoped>
.monaco-box { min-height: 60px; border-radius: var(--radius-sm); }
</style>
