<script setup lang="ts">
</script>

<template>
  <router-view />
</template>

<style>
:root {
  --bg: #f0f2f5;
  --bg-card: #ffffff;
  --bg-inset: #f8f9fb;
  --text-primary: #1f2937;
  --text-secondary: #6b7280;
  --text-muted: #9ca3af;
  --accent: #6366f1;
  --accent-hover: #4f46e5;
  --success: #10b981;
  --warning: #f59e0b;
  --error: #ef4444;
  --border: #e5e7eb;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.05);
  --shadow: 0 1px 3px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.06);
  --shadow-lg: 0 4px 6px rgba(0,0,0,.05), 0 2px 4px rgba(0,0,0,.04);
  --radius: 8px;
  --radius-sm: 6px;
  --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: var(--bg);
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  min-height: 100vh;
}

/* ---- Badges ---- */

.badge {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 0.73rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.badge-ok { background: #d1fae5; color: #065f46; }
.badge-err { background: #fee2e2; color: #991b1b; }
.badge-warn { background: #fef3c7; color: #92400e; }
.badge-streaming { background: #e0e7ff; color: #3730a3; animation: pulse 1.5s ease-in-out infinite; }
.badge-openai { background: #e8f5e9; color: #2e7d32; }
.badge-anthropic { background: #fce4ec; color: #c62828; }

@keyframes pulse {
  0%,100% { opacity: 1; }
  50% { opacity: .6; }
}

/* ---- Detail meta (shared) ---- */

.kv {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 5px;
  font-weight: 600;
  font-size: 0.82rem;
  font-family: var(--font-mono);
}
.kv-model { background: #e0e7ff; color: #3730a3; border: 1px solid #c7d2fe; }
.kv-finish { background: #d1fae5; color: #065f46; border: 1px solid #a7f3d0; }
.kv-finish-stop { background: #d1fae5; color: #065f46; border-color: #a7f3d0; }
.kv-finish-length { background: #fee2e2; color: #991b1b; border-color: #fecaca; }
.kv-finish-tool_calls { background: #fef3c7; color: #92400e; border-color: #fde68a; }
.kv-finish-content_filter { background: #fee2e2; color: #991b1b; border-color: #fecaca; }

/* ---- Section Labels ---- */

.section-label {
  display: inline-block;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  padding: 4px 10px;
  border-radius: 4px;
  margin-bottom: 8px;
  font-weight: 600;
}
</style>
