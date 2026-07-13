<script setup lang="ts">
import BaseTextCard from './BaseTextCard.vue'

defineProps<{ text?: string }>()
</script>

<template>
  <BaseTextCard title="拒绝" :text="text" tone="refusal" />
</template>
