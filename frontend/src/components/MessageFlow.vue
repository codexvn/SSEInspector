<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  body: Record<string, unknown>
  apiType: 'openai' | 'anthropic'
}>()

// ---- 类型 ----
interface FlowBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  index: number
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

interface FlowItem {
  kind: 'header' | 'system' | 'user' | 'assistant' | 'block' | 'tool' | 'tools_header'
  seq?: number
  role?: string
  label: string
  content?: string
  blocks?: FlowBlock[]
  blockCount?: number
  toolName?: string
  toolCallId?: string
  extra?: unknown
}

// ---- 折叠状态 ----
const collapsed = ref(new Set<string>())
function toggle(id: string) {
  if (collapsed.value.has(id)) collapsed.value.delete(id)
  else collapsed.value.add(id)
  collapsed.value = new Set(collapsed.value) // trigger reactivity
}
function isCollapsed(id: string) { return collapsed.value.has(id) }

// ---- 解析 ----
const items = computed<FlowItem[]>(() => {
  const b = props.body
  if (!b) return []
  const result: FlowItem[] = []
  const tools = Array.isArray(b.tools) ? b.tools : undefined

  // === 请求头 ===
  const parts: string[] = []
  if (b.model) parts.push(`model: ${b.model}`)
  if (b.max_tokens) parts.push(`max_tokens: ${b.max_tokens}`)
  if (b.temperature != null) parts.push(`temperature: ${b.temperature}`)
  if (tools) parts.push(`tools: ${tools.length}`)
  if (parts.length) result.push({ kind: 'header', label: '', content: parts.join('  ·  ') })

  // === System ===
  const system = getSystem(b)
  if (system) {
    if (typeof system === 'string') {
      result.push({ kind: 'system', label: '', content: system })
    } else if (Array.isArray(system)) {
      const blocks: FlowBlock[] = (system as unknown[]).map((s, i) => ({
        type: 'text' as const, index: i,
        text: typeof (s as Record<string, unknown>).text === 'string' ? (s as Record<string, unknown>).text as string : JSON.stringify(s),
      }))
      result.push({ kind: 'system', label: `(${blocks.length} 块)`, blocks, blockCount: blocks.length })
    }
  }

  // === Tools ===
  if (tools && tools.length > 0) {
    const names: string[] = []
    for (const t of tools) {
      const name = (t as Record<string, unknown>).name || ((t as Record<string, unknown>).function as Record<string, unknown>)?.name
      if (name) names.push(String(name))
    }
    result.push({
      kind: 'tools_header',
      label: `${names.length} 个`,
      content: names.join(', '),
    })
  }

  // === Messages ===
  const messages = (b.messages ?? b.input) as Record<string, unknown>[] | undefined
  if (messages) {
    const counts: Record<string, number> = {}
    for (const msg of messages) {
      const role = extractRole(msg)
      counts[role] = (counts[role] ?? 0) + 1
      const seq = counts[role]
      result.push(...parseMessage(msg, role, seq))
    }
  }

  return result
})

function getSystem(body: Record<string, unknown>): unknown {
  if (body.system != null) return body.system
  const msgs = body.messages as Record<string, unknown>[] | undefined
  if (msgs) {
    const sys = msgs.filter(m => m.role === 'system')
    if (sys.length) return sys.map(s => s.content).filter(Boolean).join('\n\n')
  }
  return null
}

function extractRole(msg: Record<string, unknown>): string {
  return String(msg.role ?? 'user')
}

function parseMessage(msg: Record<string, unknown>, role: string, seq: number): FlowItem[] {
  const items: FlowItem[] = []
  if (role === 'system') return items
  const content = msg.content

  if (typeof content === 'string') {
    if (role === 'tool') {
      items.push({ kind: 'tool', role, seq, label: `#${seq}`, content,
        toolName: (msg.name || msg.tool_call_id) as string, toolCallId: msg.tool_call_id as string })
    } else {
      const kind = role === 'user' ? 'user' : 'assistant'
      items.push({ kind, role, seq, label: `#${seq}`, content })
    }
  } else if (Array.isArray(content)) {
    const blocks: FlowBlock[] = (content as unknown[]).map((b, i) => {
      const block = b as Record<string, unknown>
      return { type: (block.type as FlowBlock['type']) || 'text', index: i,
        text: block.text as string, id: block.id as string, name: block.name as string,
        input: block.input, tool_use_id: block.tool_use_id as string, content: block.content }
    })
    items.push({ kind: 'block', role, seq, label: `#${seq}`, blocks, blockCount: blocks.length })
  } else if (content && typeof content === 'object') {
    const kind = role === 'user' ? 'user' : 'assistant'
    items.push({ kind, role, seq, label: `#${seq}`, content: JSON.stringify(content, null, 2) })
  }

  // OpenAI tool_calls on assistant
  const toolCalls = msg.tool_calls as Record<string, unknown>[] | undefined
  if (role === 'assistant' && toolCalls?.length) {
    if (items.length) items[items.length - 1].extra = toolCalls
    else items.push({ kind: 'assistant', role, seq, label: `#${seq}`, content: '', extra: toolCalls })
  }

  return items
}

function blockRoleLabel(item: FlowItem): string {
  switch (item.kind) {
    case 'header': return ''
    case 'system': return item.blocks ? '📋 System' : 'System'
    case 'tools_header': return 'Tools'
    case 'user': return 'User'
    case 'assistant': return item.extra ? 'Ass + ⚙' : 'Assistant'
    case 'tool': return 'Tool'
    case 'block': return item.role === 'user' ? 'User' : 'Assistant'
    default: return ''
  }
}
</script>

<template>
  <div class="msg-flow">
    <div
      v-for="(item, idx) in items"
      :key="idx"
      class="msg-item"
      :class="`msg-${item.kind}`"
    >
      <!-- 卡片 -->
      <div class="msg-card">
        <div class="msg-card-header" :class="{ 'hd-only': item.kind === 'header' }" @click="item.content && item.content.length > 300 ? toggle(`c-${idx}`) : undefined">
          <template v-if="item.kind === 'header'">
            <span class="msg-meta-text">{{ item.content }}</span>
          </template>
          <template v-else>
            <span class="msg-role-badge" :class="`role-${item.kind}`">{{ blockRoleLabel(item) }}</span>
            <span v-if="item.kind === 'tool' && item.toolName" class="msg-toolname">{{ item.toolName }}</span>
            <span v-if="item.blockCount" class="msg-blockcnt">{{ item.blockCount }} 块</span>
            <span class="msg-seq">{{ item.label }}</span>
          </template>
        </div>

        <div class="msg-card-body" v-if="item.content || item.blocks || item.extra" :class="{ collapsed: isCollapsed(`c-${idx}`) }">
          <!-- 纯文本 -->
          <div v-if="item.content" class="msg-text" :class="{ 'msg-text-long': item.content.length > 300 }">
            {{ item.content }}
          </div>

          <!-- OpenAI tool_calls -->
          <template v-if="item.extra && Array.isArray(item.extra)">
            <div v-for="(tc, tci) in item.extra" :key="tci" class="msg-block msg-block-tool_use">
              <div class="msg-block-hd">⚙ {{ (tc.function as Record<string,unknown>)?.name ?? tc.name }}</div>
              <pre class="msg-block-pre">{{ typeof (tc.function as Record<string,unknown>)?.arguments === 'string' ? (tc.function as Record<string,unknown>).arguments : JSON.stringify(tc.input ?? tc, null, 2) }}</pre>
            </div>
          </template>

          <!-- content blocks -->
          <template v-if="item.blocks">
            <div
              v-for="(b, bi) in item.blocks"
              :key="bi"
              class="msg-block"
              :class="`msg-block-${b.type}`"
            >
              <template v-if="b.type === 'text'">
                <div v-if="item.blocks!.length > 1" class="msg-block-hd msg-hd-text">📄</div>
                <div class="msg-text">{{ b.text }}</div>
              </template>
              <template v-else-if="b.type === 'tool_use'">
                <div class="msg-block-hd msg-hd-tool_use">⚙ {{ b.name }}</div>
                <pre class="msg-block-pre">{{ typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}, null, 2) }}</pre>
              </template>
              <template v-else-if="b.type === 'tool_result'">
                <div class="msg-block-hd msg-hd-tool_result">📥 {{ b.name || b.tool_use_id?.slice(0, 16) }}</div>
                <div class="msg-text">{{ typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? {}, null, 2) }}</div>
              </template>
              <template v-else>
                <pre class="msg-block-pre">{{ JSON.stringify(b, null, 2) }}</pre>
              </template>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.msg-flow { display: flex; flex-direction: column; font-size: 0.82rem; line-height: 1.6; padding: 4px 0; }

/* 时间线：左 border 竖线 + ::before 圆点 */
.msg-flow { padding-left: 20px; border-left: 2px solid var(--border); margin-left: 4px; }
.msg-item { position: relative; margin-bottom: 6px; }
.msg-item:last-child { margin-bottom: 0; }
.msg-item::before {
  content: ''; position: absolute;
  left: -26px; top: 10px;
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--border); z-index: 1;
}
.msg-card-header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 12px; background: var(--bg-inset); border-bottom: 1px solid var(--border); font-size: 0.74rem; }
.msg-card-header.hd-only { border-bottom: none; cursor: default; }
.msg-card-body { padding: 10px 14px; }
.msg-card-body.collapsed { max-height: 200px; overflow: hidden; position: relative; }
.msg-card-body.collapsed::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 40px; background: linear-gradient(transparent, var(--bg-card)); }

/* 标签 */
.msg-role-badge { padding: 1px 7px; border-radius: 8px; font-size: 0.64rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
.msg-seq { font-family: var(--font-mono); font-size: 0.66rem; color: var(--text-muted); }
.msg-meta-text { font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-secondary); }
.msg-toolname { font-family: var(--font-mono); font-size: 0.68rem; color: #7b1fa2; font-weight: 600; }
.msg-blockcnt { font-size: 0.64rem; color: var(--text-muted); }

/* badge 颜色 */
.role-system { background: #f5f5f5; color: #616161; }
.role-user { background: #e3f2fd; color: #1565c0; }
.role-assistant { background: #e8f5e9; color: #2e7d32; }
.role-tool { background: #f3e5f5; color: #7b1fa2; }
.role-block { background: #eceff1; color: #546e7a; }
.role-header {}
.role-tools_header { background: #fce4ec; color: #c62828; }

/* 卡片边框 + 圆点颜色 */
.msg-system .msg-card { border-left-color: #9e9e9e; } .msg-system::before { background: #9e9e9e; }
.msg-user .msg-card { border-left-color: #42a5f5; } .msg-user::before { background: #42a5f5; }
.msg-assistant .msg-card { border-left-color: #66bb6a; } .msg-assistant::before { background: #66bb6a; }
.msg-tool .msg-card { border-left-color: #ab47bc; } .msg-tool::before { background: #ab47bc; }
.msg-block .msg-card { border-left-color: #78909c; } .msg-block::before { background: #78909c; }
.msg-header .msg-card { border-left-color: #ff9800; } .msg-header::before { background: #ff9800; }
.msg-tools_header .msg-card { border-left-color: #ef5350; } .msg-tools_header::before { background: #ef5350; }

/* 文本 */
.msg-text { white-space: pre-wrap; word-break: break-word; }
.msg-text-long { font-size: 0.78rem; }

/* blocks */
.msg-block { border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; margin-top: 6px; }
.msg-block + .msg-block { margin-top: 4px; }
.msg-block:first-child { margin-top: 0; }
.msg-block-hd { padding: 4px 10px; font-size: 0.7rem; font-weight: 600; border-bottom: 1px solid var(--border); }
.msg-hd-text { background: #eceff1; color: #546e7a; }
.msg-hd-tool_use { background: #eef2ff; color: #4338ca; }
.msg-hd-tool_result { background: #fff8e1; color: #f57f17; }
.msg-block-pre { margin: 0; padding: 8px 10px; font-family: var(--font-mono); font-size: 0.72rem; white-space: pre-wrap; word-break: break-all; }
</style>
