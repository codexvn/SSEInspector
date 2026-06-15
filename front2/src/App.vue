<script setup lang="ts">
</script>

<template>
  <router-view />
</template>

<style>
:root {
  --bg: #f0f2f5;
  --bg-card: #ffffff;
  --text: #1a1a2e;
  --text-secondary: #6b7280;
  --accent: #6366f1;
  --error: #ef4444;
  --ok: #22c55e;
  --warn: #f59e0b;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
  line-height: 1.5;
}

button {
  font-family: inherit; font-size: 0.85rem;
  cursor: pointer;
  border: none;
  border-radius: 6px;
  padding: 6px 14px;
}
button:disabled { opacity: 0.4; cursor: default; }

table { border-collapse: collapse; width: 100%; }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #e5e7eb; }
th { font-weight: 600; color: var(--text-secondary); font-size: 0.8rem; text-transform: uppercase; }

.badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
}
.badge-ok { background: #dcfce7; color: #16a34a; }
.badge-warn { background: #fef3c7; color: #d97706; }
.badge-err { background: #fee2e2; color: #dc2626; }
.badge-streaming { background: #e0e7ff; color: #4f46e5; }
.badge-openai { background: #dbeafe; color: #2563eb; }
.badge-anthropic { background: #fae8ff; color: #9333ea; }
</style>
