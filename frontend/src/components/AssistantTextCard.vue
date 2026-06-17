<script setup lang="ts">
import BaseTextCard from './BaseTextCard.vue'

defineProps<{ text?: string }>()
</script>

<template>
  <BaseTextCard title="回答" :text="text" tone="assistant" />
</template>
