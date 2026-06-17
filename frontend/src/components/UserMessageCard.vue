<script setup lang="ts">
import BaseTextCard from './BaseTextCard.vue'

withDefaults(defineProps<{ text?: string; title?: string }>(), {
  title: '用户',
})
</script>

<template>
  <BaseTextCard :title="title" :text="text" tone="user" />
</template>
