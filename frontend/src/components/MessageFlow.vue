<script setup lang="ts">
import { computed, nextTick, ref, watch, type ComponentPublicInstance } from 'vue'
import SystemMessageCard from './SystemMessageCard.vue'
import UserMessageCard from './UserMessageCard.vue'
import AssistantTextCard from './AssistantTextCard.vue'
import AssistantThinkingCard from './AssistantThinkingCard.vue'
import ToolCallCard from './ToolCallCard.vue'
import ToolCallResultCard from './ToolCallResultCard.vue'
import MessageMetaCard from './MessageMetaCard.vue'
import ToolsListCard from './ToolsListCard.vue'
import RawJsonCard from './RawJsonCard.vue'
import type { ApiEndpoint } from '../types'
import { detectApiEndpoint } from '../composables/useApiEndpoint'

type MessageFlowFormat = ApiEndpoint | 'unknown'
type MessageFlowCardType =
  | 'system_message'
  | 'user_message'
  | 'assistant_text'
  | 'assistant_thinking'
  | 'tool_call_request'
  | 'tool_call_result'
  | 'message_meta'
  | 'tools_list'
  | 'raw_json'

interface MessageFlowCardDescriptor {
  id: string
  type: MessageFlowCardType
  props: Record<string, unknown>
  toolCallId?: string
}

interface MessageFlowGroupDescriptor {
  id: string
  title: string
  subtitle?: string
  badges: string[]
  isNew: boolean
  cards: MessageFlowCardDescriptor[]
}

const props = defineProps<{
  body: Record<string, unknown>
  previousBody?: Record<string, unknown>
  apiType: 'openai' | 'anthropic'
  path?: string
}>()

const format = computed(() => detectApiEndpoint(props.path, props.apiType))
const groups = computed<MessageFlowGroupDescriptor[]>(() => buildGroups(props.body, format.value, props.previousBody))
const newGroupCount = computed(() => groups.value.filter(group => group.isNew).length)
const totalGroupCount = computed(() => groups.value.length)
const expandedGroupIds = ref(new Set<string>())
const activeGroupId = ref('')
const groupElements = new Map<string, HTMLElement>()
const rootEl = ref<HTMLElement | null>(null)
const activeGroupIndex = computed(() => groups.value.findIndex(group => group.id === activeGroupId.value))
const activeGroupPosition = computed(() => activeGroupIndex.value >= 0 ? activeGroupIndex.value + 1 : 0)
const renderedGroupIds = ref(new Set<string>())
const pinnedGroupIds = ref(new Set<string>())
const renderWindowSize = 2

watch(groups, nextGroups => {
  const nextIds = new Set(nextGroups.map(group => group.id))
  const expanded = new Set([...expandedGroupIds.value].filter(id => nextIds.has(id)))
  for (const group of nextGroups) {
    if (!expandedGroupIds.value.has(group.id)) expanded.add(group.id)
  }
  expandedGroupIds.value = expanded
  if (!nextIds.has(activeGroupId.value)) activeGroupId.value = nextGroups[0]?.id ?? ''
  const activeIndex = nextGroups.findIndex(group => group.id === activeGroupId.value)
  updateRenderedGroups(activeIndex < 0 ? 0 : activeIndex)
}, { immediate: true })

function isGroupExpanded(groupId: string): boolean {
  return expandedGroupIds.value.has(groupId)
}

function toggleGroup(groupId: string) {
  const expanded = new Set(expandedGroupIds.value)
  if (expanded.has(groupId)) expanded.delete(groupId)
  else expanded.add(groupId)
  expandedGroupIds.value = expanded
  if (expanded.has(groupId)) renderGroup(groupId)
}

function setGroupElement(groupId: string, element: Element | ComponentPublicInstance | null) {
  if (element instanceof HTMLElement) groupElements.set(groupId, element)
  else groupElements.delete(groupId)
}

/** 查找最近的纵向可滚动祖先（消息流弹窗内为 .diff-modal-body.flow-body） */
/** 消息流内容的滚动容器（顶栏固定，仅 .msg-flow-body 滚动） */
function scrollContainerOf(el: HTMLElement | null): HTMLElement | null {
  return el?.querySelector<HTMLElement>('.msg-flow-body') ?? null
}

/** 累加 offsetTop 到滚动容器，得到目标相对容器的静态偏移（不受当前滚动位置影响） */
function offsetTopWithin(target: HTMLElement, container: HTMLElement): number {
  let top = 0
  let el: HTMLElement | null = target
  while (el && el !== container) {
    top += el.offsetTop
    el = el.offsetParent as HTMLElement | null
  }
  return top
}

function focusGroup(index: number) {
  const group = groups.value[index]
  if (!group) return
  activeGroupId.value = group.id
  updateRenderedGroups(index)
  const expanded = new Set(expandedGroupIds.value)
  expanded.add(group.id)
  expandedGroupIds.value = expanded
  nextTick(() => {
    const container = scrollContainerOf(rootEl.value)
    const target = groupElements.get(group.id)
    if (!container || !target) return
    const head = rootEl.value?.querySelector<HTMLElement>('.msg-flow-sticky-head')
    const offset = offsetTopWithin(target, container) - (head?.offsetHeight ?? 0)
    container.scrollTop = Math.max(offset, 0)
  })
}

function focusPreviousGroup() {
  focusGroup(Math.max(activeGroupIndex.value - 1, 0))
}

function focusNextGroup() {
  const currentIndex = activeGroupIndex.value < 0 ? 0 : activeGroupIndex.value
  focusGroup(Math.min(currentIndex + 1, groups.value.length - 1))
}

function timelineTitle(group: MessageFlowGroupDescriptor, index: number): string {
  return `#${index + 1} ${group.title} ${group.badges.join(' ')}`
}

function shouldRenderGroupBody(groupId: string): boolean {
  return renderedGroupIds.value.has(groupId)
}

function renderGroup(groupId: string) {
  pinnedGroupIds.value = new Set([...pinnedGroupIds.value, groupId])
  if (!renderedGroupIds.value.has(groupId)) {
    renderedGroupIds.value = new Set([...renderedGroupIds.value, groupId])
  }
}

function updateRenderedGroups(centerIndex: number) {
  const nextRendered = new Set(pinnedGroupIds.value)
  const start = Math.max(centerIndex - renderWindowSize, 0)
  const end = Math.min(centerIndex + renderWindowSize, groups.value.length - 1)
  for (let index = start; index <= end; index++) {
    const group = groups.value[index]
    if (group) nextRendered.add(group.id)
  }
  renderedGroupIds.value = nextRendered
}


function buildGroups(body: Record<string, unknown>, fmt: MessageFlowFormat, previousBody?: Record<string, unknown>): MessageFlowGroupDescriptor[] {
  const groups: MessageFlowGroupDescriptor[] = [
    {
      id: 'request-meta',
      title: '请求参数',
      badges: ['元信息'],
      isNew: false,
      cards: buildMetaCards(body, fmt),
    },
  ]
  const markNewGroup = createNewGroupMarker(previousBody ? comparisonItems(previousBody, fmt) : undefined)
  switch (fmt) {
    case 'openai-chat':
      return [...groups, ...buildOpenAIChatGroups(body, markNewGroup)]
    case 'openai-responses':
      return [...groups, ...buildOpenAIResponsesGroups(body, markNewGroup)]
    case 'anthropic-messages':
      return [...groups, ...buildAnthropicGroups(body, markNewGroup)]
    default:
      return [
        ...groups,
        {
          id: 'unknown-body-group',
          title: '未知请求体',
          badges: ['原始数据'],
          isNew: false,
          cards: [rawCard('unknown-body', '未知请求体', body)],
        },
      ]
  }
}

function buildMetaCards(body: Record<string, unknown>, fmt: MessageFlowFormat): MessageFlowCardDescriptor[] {
  const tools = Array.isArray(body.tools) ? body.tools : []
  const result: MessageFlowCardDescriptor[] = [
    {
      id: 'meta',
      type: 'message_meta',
      props: {
        model: stringValue(body.model),
        endpoint: fmt,
        stream: typeof body.stream === 'boolean' ? body.stream : undefined,
        maxTokens: body.max_tokens ?? body.max_output_tokens,
        temperature: body.temperature,
        toolChoice: body.tool_choice,
        parallelToolCalls: body.parallel_tool_calls,
      },
    },
  ]
  if (tools.length) {
    result.push({ id: 'tools', type: 'tools_list', props: { tools } })
  }
  return result
}

function buildOpenAIChatGroups(body: Record<string, unknown>, markNewGroup: (item: unknown) => boolean): MessageFlowGroupDescriptor[] {
  const messages = arrayOfRecords(body.messages)
  const result: MessageFlowGroupDescriptor[] = []
  messages.forEach((message, index) => {
    const cards: MessageFlowCardDescriptor[] = []
    const role = String(message.role ?? 'unknown')
    if (role === 'system') {
      cards.push(textCard(`chat-system-${index}`, 'system_message', stringifyContent(message.content)))
    } else if (role === 'user') {
      pushContentCards(cards, `chat-user-${index}`, 'user_message', message.content)
    } else if (role === 'assistant') {
      if (typeof message.reasoning_content === 'string') {
        cards.push(textCard(`chat-thinking-${index}`, 'assistant_thinking', message.reasoning_content))
      }
      pushContentCards(cards, `chat-assistant-${index}`, 'assistant_text', message.content)
      for (const [toolIndex, toolCall] of arrayOfRecords(message.tool_calls).entries()) {
        cards.push(toolRequestCard(`chat-tool-request-${index}-${toolIndex}`, toolCall))
      }
    } else if (role === 'tool') {
      cards.push(toolResultCard(`chat-tool-result-${index}`, message))
    } else {
      cards.push(rawCard(`chat-raw-${index}`, `未知 Chat 消息: ${role}`, message))
    }
    result.push(messageGroup(`chat-message-${index}`, `messages[${index}]`, role, message, cards, markNewGroup(message)))
  })
  return result
}

function buildOpenAIResponsesGroups(body: Record<string, unknown>, markNewGroup: (item: unknown) => boolean): MessageFlowGroupDescriptor[] {
  const result: MessageFlowGroupDescriptor[] = []
  if (typeof body.instructions === 'string') {
    result.push(messageGroup('responses-instructions-group', 'instructions', 'system', body.instructions, [
      textCard('responses-instructions', 'system_message', body.instructions),
    ], markNewGroup(body.instructions)))
  } else if (body.instructions !== undefined) {
    result.push(messageGroup('responses-instructions-group', 'instructions', 'system', body.instructions, [
      rawCard('responses-instructions-raw', 'Instructions', body.instructions),
    ], markNewGroup(body.instructions)))
  }

  const input = body.input
  if (typeof input === 'string') {
    result.push(messageGroup('responses-input-group', 'input', 'user', input, [
      textCard('responses-input', 'user_message', input),
    ], markNewGroup(input)))
    return result
  }
  if (!Array.isArray(input)) {
    if (input !== undefined) {
      result.push(messageGroup('responses-input-group', 'input', 'unknown', input, [
        rawCard('responses-input-raw', 'Responses Input', input),
      ], markNewGroup(input)))
    }
    return result
  }

  input.forEach((item, index) => {
    const cards: MessageFlowCardDescriptor[] = []
    if (!isRecord(item)) {
      cards.push(rawCard(`responses-raw-${index}`, '未知 Responses 项', item))
      result.push(messageGroup(`responses-item-${index}`, `input[${index}]`, 'unknown', item, cards, markNewGroup(item)))
      return
    }
    const type = String(item.type ?? '')
    const role = String(item.role ?? '')
    if (type === 'message' || role) {
      const targetRole = role || 'user'
      if (targetRole === 'system') pushContentCards(cards, `responses-system-${index}`, 'system_message', item.content)
      else if (targetRole === 'assistant') pushContentCards(cards, `responses-assistant-${index}`, 'assistant_text', item.content)
      else pushContentCards(cards, `responses-user-${index}`, 'user_message', item.content)
      result.push(messageGroup(`responses-item-${index}`, `input[${index}]`, targetRole, item, cards, markNewGroup(item)))
      return
    }
    if (type === 'function_call' || type === 'custom_tool_call') cards.push(toolRequestCard(`responses-tool-request-${index}`, item))
    else if (type === 'function_call_output') cards.push(toolResultCard(`responses-tool-result-${index}`, item))
    else if (typeof item.text === 'string') cards.push(textCard(`responses-text-${index}`, 'assistant_text', item.text))
    else if (typeof item.thinking === 'string') cards.push(textCard(`responses-thinking-${index}`, 'assistant_thinking', item.thinking))
    else cards.push(rawCard(`responses-raw-${index}`, `未知 Responses 项: ${type || 'unknown'}`, item))
    result.push(messageGroup(`responses-item-${index}`, `input[${index}]`, type || 'unknown', item, cards, markNewGroup(item)))
  })

  return result
}

function buildAnthropicGroups(body: Record<string, unknown>, markNewGroup: (item: unknown) => boolean): MessageFlowGroupDescriptor[] {
  const result: MessageFlowGroupDescriptor[] = []
  if (typeof body.system === 'string') {
    result.push(messageGroup('anthropic-system-group', 'system', 'system', body.system, [
      textCard('anthropic-system', 'system_message', body.system),
    ], markNewGroup(body.system)))
  } else if (Array.isArray(body.system)) {
    const cards: MessageFlowCardDescriptor[] = []
    pushAnthropicBlocks(cards, 'anthropic-system', 'system_message', body.system)
    result.push(messageGroup('anthropic-system-group', 'system', 'system', body.system, cards, markNewGroup(body.system)))
  } else if (body.system !== undefined) {
    result.push(messageGroup('anthropic-system-group', 'system', 'system', body.system, [
      rawCard('anthropic-system-raw', 'System', body.system),
    ], markNewGroup(body.system)))
  }

  arrayOfRecords(body.messages).forEach((message, index) => {
    const cards: MessageFlowCardDescriptor[] = []
    const role = String(message.role ?? 'user')
    if (typeof message.content === 'string') {
      cards.push(textCard(`anthropic-${role}-${index}`, role === 'assistant' ? 'assistant_text' : 'user_message', message.content))
    } else if (Array.isArray(message.content)) {
      pushAnthropicBlocks(cards, `anthropic-${role}-${index}`, role === 'assistant' ? 'assistant_text' : 'user_message', message.content)
    } else {
      cards.push(rawCard(`anthropic-raw-${index}`, `未知 Anthropic 消息: ${role}`, message))
    }
    result.push(messageGroup(`anthropic-message-${index}`, `messages[${index}]`, role, message, cards, markNewGroup(message)))
  })
  return result
}

function pushAnthropicBlocks(result: MessageFlowCardDescriptor[], prefix: string, fallbackType: MessageFlowCardType, blocks: unknown[]) {
  blocks.forEach((block, index) => {
    if (!isRecord(block)) {
      result.push(rawCard(`${prefix}-raw-${index}`, '未知 Anthropic 块', block))
      return
    }
    const type = String(block.type ?? '')
    if (type === 'text') result.push(textCard(`${prefix}-text-${index}`, fallbackType, stringifyContent(block.text)))
    else if (type === 'thinking') result.push(textCard(`${prefix}-thinking-${index}`, 'assistant_thinking', stringifyContent(block.thinking)))
    else if (type === 'tool_use') result.push(toolRequestCard(`${prefix}-tool-request-${index}`, block))
    else if (type === 'tool_result') result.push(toolResultCard(`${prefix}-tool-result-${index}`, block))
    else result.push(rawCard(`${prefix}-raw-${index}`, `未知 Anthropic 块: ${type || 'unknown'}`, block))
  })
}

function pushContentCards(result: MessageFlowCardDescriptor[], prefix: string, type: MessageFlowCardType, content: unknown) {
  if (typeof content === 'string') {
    result.push(textCard(prefix, type, content))
    return
  }
  if (Array.isArray(content)) {
    content.forEach((block, index) => {
      if (!isRecord(block)) {
        result.push(rawCard(`${prefix}-raw-${index}`, '未知内容块', block))
        return
      }
      const blockType = String(block.type ?? '')
      if (typeof block.text === 'string') result.push(textCard(`${prefix}-text-${index}`, type, block.text))
      else if (typeof block.input_text === 'string') result.push(textCard(`${prefix}-input-text-${index}`, type, block.input_text))
      else if (typeof block.output_text === 'string') result.push(textCard(`${prefix}-output-text-${index}`, type, block.output_text))
      else result.push(rawCard(`${prefix}-raw-${index}`, `未知内容块: ${blockType || 'unknown'}`, block))
    })
    return
  }
  if (content !== undefined && content !== null) result.push(rawCard(`${prefix}-raw`, '未知内容', content))
}

function messageGroup(
  id: string,
  title: string,
  role: string,
  source: unknown,
  cards: MessageFlowCardDescriptor[],
  isNew: boolean,
): MessageFlowGroupDescriptor {
  return {
    id,
    title,
    subtitle: summarizeGroupSource(source),
    badges: groupBadges(role, cards),
    isNew,
    cards,
  }
}

function groupBadges(role: string, cards: MessageFlowCardDescriptor[]): string[] {
  const roleBadge = roleLabel(role)
  const badges = [roleBadge]
  const toolCallCount = cards.filter(card => card.type === 'tool_call_request').length
  const toolResultCount = cards.filter(card => card.type === 'tool_call_result').length
  if (toolCallCount && roleBadge === '工具调用' && toolCallCount > 1) badges[0] = `工具调用 x ${toolCallCount}`
  else if (toolCallCount && roleBadge !== '工具调用') badges.push(`工具调用 ${toolCallCount}`)
  if (toolResultCount && roleBadge === '工具结果' && toolResultCount > 1) badges[0] = `工具结果 x ${toolResultCount}`
  else if (toolResultCount && roleBadge !== '工具结果') badges.push(`工具结果 ${toolResultCount}`)
  if (cards.some(card => card.type === 'assistant_thinking')) badges.push('思考')
  return badges
}

function roleLabel(role: string): string {
  return {
    system: '系统',
    user: '用户',
    assistant: '助手',
    tool: '工具',
    function_call: '工具调用',
    custom_tool_call: '自定义工具',
    function_call_output: '工具结果',
  }[role] ?? role
}

function summarizeGroupSource(source: unknown): string | undefined {
  if (typeof source === 'string') return truncate(source)
  if (!isRecord(source)) return undefined
  const content = source.content
  if (typeof content === 'string') return truncate(content)
  if (Array.isArray(content)) {
    const firstText = content
      .filter(isRecord)
      .map(block => stringValue(block.text ?? block.input_text ?? block.output_text ?? block.thinking))
      .find(Boolean)
    if (firstText) return truncate(firstText)
  }
  const fn = isRecord(source.function) ? source.function : undefined
  const name = stringValue(source.name ?? source.tool_name ?? fn?.name)
  if (name) return name
  return undefined
}

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 120 ? `${normalized.slice(0, 120)}...` : normalized
}

function createNewGroupMarker(previousItems?: Map<string, number>): (item: unknown) => boolean {
  if (!previousItems) return () => false
  return item => {
    const key = stableStringify(item)
    const remainingCount = previousItems.get(key) ?? 0
    if (remainingCount <= 0) return true
    previousItems.set(key, remainingCount - 1)
    return false
  }
}

function comparisonItems(body: Record<string, unknown>, fmt: MessageFlowFormat): Map<string, number> {
  const result = new Map<string, number>()
  for (const item of comparableItems(body, fmt)) {
    const key = stableStringify(item)
    result.set(key, (result.get(key) ?? 0) + 1)
  }
  return result
}

function comparableItems(body: Record<string, unknown>, fmt: MessageFlowFormat): unknown[] {
  switch (fmt) {
    case 'openai-chat':
    case 'anthropic-messages':
      return [
        ...(body.system !== undefined ? [body.system] : []),
        ...arrayOfRecords(body.messages),
      ]
    case 'openai-responses':
      return [
        ...(body.instructions !== undefined ? [body.instructions] : []),
        ...(Array.isArray(body.input) ? body.input : body.input !== undefined ? [body.input] : []),
      ]
    default:
      return []
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function textCard(id: string, type: MessageFlowCardType, text: string): MessageFlowCardDescriptor {
  return { id, type, props: { text } }
}

function toolRequestCard(id: string, source: Record<string, unknown>): MessageFlowCardDescriptor {
  const fn = isRecord(source.function) ? source.function : undefined
  const toolCallId = stringValue(source.id ?? source.call_id ?? source.tool_call_id) ?? id
  const toolName = stringValue(source.name ?? fn?.name ?? source.tool_name) ?? 'tool'
  const rawArgs = source.arguments ?? source.input ?? fn?.arguments ?? source
  return {
    id,
    type: 'tool_call_request',
    toolCallId,
    props: {
      toolCallId,
      toolName,
      toolArgs: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs, null, 2),
      requestId: '',
      side: 'request',
    },
  }
}

function toolResultCard(id: string, source: Record<string, unknown>): MessageFlowCardDescriptor {
  const toolCallId = stringValue(source.tool_call_id ?? source.tool_use_id ?? source.call_id ?? source.id) ?? id
  const result = source.output ?? source.content ?? source.result ?? source
  return {
    id,
    type: 'tool_call_result',
    toolCallId,
    props: {
      toolCallId,
      toolName: stringValue(source.name ?? source.tool_name),
      result: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
    },
  }
}

function rawCard(id: string, title: string, value: unknown): MessageFlowCardDescriptor {
  return { id, type: 'raw_json', props: { title, value } }
}

function componentFor(type: MessageFlowCardType) {
  return {
    system_message: SystemMessageCard,
    user_message: UserMessageCard,
    assistant_text: AssistantTextCard,
    assistant_thinking: AssistantThinkingCard,
    tool_call_request: ToolCallCard,
    tool_call_result: ToolCallResultCard,
    message_meta: MessageMetaCard,
    tools_list: ToolsListCard,
    raw_json: RawJsonCard,
  }[type]
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  return JSON.stringify(value, null, 2)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}
</script>

<template>
  <div class="msg-flow" ref="rootEl">
    <div class="msg-flow-sticky-head">
      <div class="msg-flow-toolbar">
        <span class="msg-flow-total">总数 {{ totalGroupCount }}</span>
        <span class="msg-flow-current">当前 {{ activeGroupPosition }} / {{ totalGroupCount }}</span>
        <button class="msg-flow-nav-btn" type="button" :disabled="activeGroupIndex <= 0" @click="focusPreviousGroup">上一个</button>
        <button class="msg-flow-nav-btn" type="button" :disabled="activeGroupIndex < 0 || activeGroupIndex >= totalGroupCount - 1" @click="focusNextGroup">下一个</button>
      </div>
      <div v-if="newGroupCount" class="msg-flow-new-summary">
        本次新增 {{ newGroupCount }} 组内容
      </div>
    </div>
    <div class="msg-flow-body">
    <div
      v-for="(group, index) in groups"
      :key="group.id"
      :ref="element => setGroupElement(group.id, element)"
      class="msg-flow-group"
      :class="{ 'msg-flow-group-new': group.isNew, 'msg-flow-group-active': activeGroupId === group.id }"
    >
      <button
        class="msg-flow-anchor"
        type="button"
        :title="timelineTitle(group, index)"
        @click.stop="focusGroup(index)"
      >
        #{{ index + 1 }}
      </button>
      <button class="msg-flow-group-head" type="button" @click="toggleGroup(group.id)">
        <div class="msg-flow-group-title">
          <span class="msg-flow-toggle">{{ isGroupExpanded(group.id) ? '收起' : '展开' }}</span>
          <span>{{ group.title }}</span>
          <span v-if="group.isNew" class="msg-flow-new-badge">新增</span>
        </div>
        <div class="msg-flow-group-badges">
          <span v-for="badge in group.badges" :key="badge" class="msg-flow-badge">{{ badge }}</span>
        </div>
        <div v-if="group.subtitle" class="msg-flow-group-subtitle">{{ group.subtitle }}</div>
      </button>
      <div v-if="isGroupExpanded(group.id) && shouldRenderGroupBody(group.id)" class="msg-flow-group-body">
        <div v-for="card in group.cards" :key="card.id" class="msg-flow-item" :class="`flow-${card.type}`">
          <component :is="componentFor(card.type)" v-bind="card.props" />
        </div>
      </div>
      <button
        v-else-if="isGroupExpanded(group.id)"
        class="msg-flow-lazy-body"
        type="button"
        @click="renderGroup(group.id)"
      >
        已展开，点击加载本组内容
      </button>
    </div>
    </div>
  </div>
</template>

<style scoped>
.msg-flow {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
  max-width: 100%;
  height: 100%;
}

.msg-flow-sticky-head {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-left: 4px;
  padding: 12px 14px 10px 52px;
  overflow-y: scroll;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border);
}

.msg-flow-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: scroll;
  margin-left: 4px;
  border-left: 2px solid var(--border);
  padding: 12px 14px 16px 52px;
}

.msg-flow-body .msg-flow-group + .msg-flow-group {
  margin-top: 12px;
}

.msg-flow-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: rgba(255,255,255,.94);
  box-shadow: var(--shadow-sm);
}

.msg-flow-total,
.msg-flow-current {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.74rem;
  white-space: nowrap;
}

.msg-flow-current {
  margin-right: auto;
}

.msg-flow-nav-btn {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.74rem;
  font-weight: 700;
  min-height: 28px;
  padding: 4px 10px;
}

.msg-flow-nav-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.msg-flow-nav-btn:disabled {
  cursor: default;
  opacity: .42;
}

.msg-flow-new-summary {
  align-self: flex-start;
  padding: 5px 10px;
  border: 1px solid #a7f3d0;
  border-radius: var(--radius-sm);
  background: #d1fae5;
  color: #065f46;
  font-size: 0.74rem;
  font-weight: 700;
}

.msg-flow-group {
  position: relative;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-inset);
}

.msg-flow-anchor {
  position: absolute;
  left: -52px;
  top: 8px;
  z-index: 1;
  min-width: 34px;
  height: 24px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-card);
  color: var(--text-muted);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  font-weight: 700;
  line-height: 1;
}

.msg-flow-anchor:hover,
.msg-flow-group-active .msg-flow-anchor {
  border-color: var(--accent);
  color: var(--accent);
}

.msg-flow-group-active {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(99,102,241,.12);
}

.msg-flow-group-new {
  border-color: #10b981;
  background: #f0fdf4;
}

.msg-flow-group-new .msg-flow-anchor {
  border-color: #10b981;
  color: #065f46;
}

.msg-flow-group-head {
  display: grid;
  width: 100%;
  grid-template-columns: minmax(140px, max-content) 1fr;
  gap: 4px 10px;
  padding: 10px 12px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: rgba(255,255,255,.76);
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.msg-flow-group-head:hover {
  background: var(--bg-card);
}

.msg-flow-group-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--text-primary);
}

.msg-flow-toggle {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 2px 7px;
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  color: var(--accent);
  border: 1px solid var(--border);
  font-size: 0.68rem;
  font-weight: 700;
}

.msg-flow-group-badges {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
}

.msg-flow-badge,
.msg-flow-new-badge {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 2px 7px;
  border-radius: var(--radius-sm);
  font-size: 0.68rem;
  font-weight: 700;
  line-height: 1.2;
}

.msg-flow-badge {
  background: var(--bg-card);
  color: var(--text-secondary);
  border: 1px solid var(--border);
}

.msg-flow-new-badge {
  background: #d1fae5;
  color: #065f46;
  border: 1px solid #a7f3d0;
}

.msg-flow-group-subtitle {
  grid-column: 1 / -1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: 0.74rem;
}

.msg-flow-group-body {
  display: flex;
  flex-direction: column;
  row-gap: 12px;
  padding: 10px;
}

.msg-flow-lazy-body {
  width: 100%;
  min-height: 42px;
  padding: 10px 12px;
  border: 0;
  background: var(--bg-inset);
  color: var(--text-muted);
  cursor: pointer;
  font-size: 0.76rem;
  text-align: left;
}

.msg-flow-lazy-body:hover {
  color: var(--accent);
  background: var(--bg-card);
}

.msg-flow-item {
  display: block;
  min-width: 0;
}

.msg-flow-item > :deep(*) {
  margin-bottom: 0;
}

@media (max-width: 768px) {
  .msg-flow-body {
    padding-left: 46px;
  }

  .msg-flow-sticky-head {
    padding-left: 46px;
  }

  .msg-flow-toolbar {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .msg-flow-current {
    margin-right: 0;
  }

  .msg-flow-anchor {
    left: -46px;
  }

  .msg-flow-group-head {
    grid-template-columns: 1fr;
  }

  .msg-flow-group-badges {
    justify-content: flex-start;
  }
}

/* 统一消息流滚动条：窄而低调，避免顶栏预留空滚动条突兀 */
.msg-flow ::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
.msg-flow ::-webkit-scrollbar-track {
  background: transparent;
}
.msg-flow ::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.18);
  border-radius: 4px;
}
.msg-flow ::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 0, 0, 0.3);
}
.msg-flow {
  scrollbar-width: thin;
  scrollbar-color: rgba(0, 0, 0, 0.18) transparent;
}
</style>
