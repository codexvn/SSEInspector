<script setup lang="ts">
import BaseTextCard from './BaseTextCard.vue'

defineProps<{ text?: string }>()
</script>

<template>
  <BaseTextCard title="System" :text="text" tone="system" />
</template>
