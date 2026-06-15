<script setup lang="ts">
import { useRequestsStore } from '../stores/requests'

const store = useRequestsStore()
</script>

<template>
  <div v-if="store.totalPages > 1" class="pagination">
    <span class="page-info">共 {{ store.total }} 条</span>
    <button :disabled="store.page <= 1" @click="store.loadPage(store.page - 1)">上一页</button>
    <span class="page-info">{{ store.page }} / {{ store.totalPages }}</span>
    <button :disabled="store.page >= store.totalPages" @click="store.loadPage(store.page + 1)">下一页</button>
  </div>
</template>

<style scoped>
.pagination {
  display: flex; gap: 16px; justify-content: center; align-items: center;
  padding: 12px 0;
}
.page-info { font-size: 0.85rem; color: var(--text-secondary); }
button {
  background: var(--bg-card); border: 1px solid #d0d5dd; color: var(--text);
}
button:hover:not(:disabled) { background: #e8ecf1; }
</style>
