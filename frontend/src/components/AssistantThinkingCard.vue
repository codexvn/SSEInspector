<script setup lang="ts">
import BaseTextCard from './BaseTextCard.vue'

defineProps<{ text?: string }>()
</script>

<template>
  <BaseTextCard title="推理过程" :text="text" tone="thinking" />
</template>
