<script setup lang="ts">
import { computed } from 'vue'
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

const props = defineProps<{
  body: Record<string, unknown>
  apiType: 'openai' | 'anthropic'
  path?: string
  upstreamUrl?: string
}>()

const format = computed(() => detectFormat(props.path, props.upstreamUrl, props.apiType, props.body))
const cards = computed<MessageFlowCardDescriptor[]>(() => buildCards(props.body, format.value))

function detectFormat(path: string | undefined, upstreamUrl: string | undefined, apiType: string, body: Record<string, unknown>): MessageFlowFormat {
  const source = `${path ?? ''} ${upstreamUrl ?? ''}`
  if (/\/chat\/completions(?:\?|$)/.test(source)) return 'openai-chat'
  if (/\/responses(?:\?|$)/.test(source)) return 'openai-responses'
  if (/\/messages(?:\?|$)/.test(source)) return 'anthropic-messages'
  if (apiType === 'anthropic') return 'anthropic-messages'
  if (Array.isArray(body.messages)) return 'openai-chat'
  if (body.input !== undefined) return 'openai-responses'
  return 'unknown'
}

function buildCards(body: Record<string, unknown>, fmt: MessageFlowFormat): MessageFlowCardDescriptor[] {
  const baseCards = buildMetaCards(body, fmt)
  switch (fmt) {
    case 'openai-chat':
      return [...baseCards, ...buildOpenAIChatCards(body)]
    case 'openai-responses':
      return [...baseCards, ...buildOpenAIResponsesCards(body)]
    case 'anthropic-messages':
      return [...baseCards, ...buildAnthropicCards(body)]
    default:
      return [...baseCards, rawCard('unknown-body', '未知请求体', body)]
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

function buildOpenAIChatCards(body: Record<string, unknown>): MessageFlowCardDescriptor[] {
  const messages = arrayOfRecords(body.messages)
  const result: MessageFlowCardDescriptor[] = []
  messages.forEach((message, index) => {
    const role = String(message.role ?? 'unknown')
    if (role === 'system') {
      result.push(textCard(`chat-system-${index}`, 'system_message', stringifyContent(message.content)))
      return
    }
    if (role === 'user') {
      pushContentCards(result, `chat-user-${index}`, 'user_message', message.content)
      return
    }
    if (role === 'assistant') {
      if (typeof message.reasoning_content === 'string') {
        result.push(textCard(`chat-thinking-${index}`, 'assistant_thinking', message.reasoning_content))
      }
      pushContentCards(result, `chat-assistant-${index}`, 'assistant_text', message.content)
      for (const [toolIndex, toolCall] of arrayOfRecords(message.tool_calls).entries()) {
        result.push(toolRequestCard(`chat-tool-request-${index}-${toolIndex}`, toolCall))
      }
      return
    }
    if (role === 'tool') {
      result.push(toolResultCard(`chat-tool-result-${index}`, message))
      return
    }
    result.push(rawCard(`chat-raw-${index}`, `未知 Chat 消息: ${role}`, message))
  })
  return result
}

function buildOpenAIResponsesCards(body: Record<string, unknown>): MessageFlowCardDescriptor[] {
  const result: MessageFlowCardDescriptor[] = []
  if (typeof body.instructions === 'string') {
    result.push(textCard('responses-instructions', 'system_message', body.instructions))
  } else if (body.instructions !== undefined) {
    result.push(rawCard('responses-instructions-raw', 'Instructions', body.instructions))
  }

  const input = body.input
  if (typeof input === 'string') {
    result.push(textCard('responses-input', 'user_message', input))
    return result
  }
  if (!Array.isArray(input)) {
    if (input !== undefined) result.push(rawCard('responses-input-raw', 'Responses Input', input))
    return result
  }

  input.forEach((item, index) => {
    if (!isRecord(item)) {
      result.push(rawCard(`responses-raw-${index}`, '未知 Responses 项', item))
      return
    }
    const type = String(item.type ?? '')
    const role = String(item.role ?? '')
    if (type === 'message' || role) {
      const targetRole = role || 'user'
      if (targetRole === 'system') pushContentCards(result, `responses-system-${index}`, 'system_message', item.content)
      else if (targetRole === 'assistant') pushContentCards(result, `responses-assistant-${index}`, 'assistant_text', item.content)
      else pushContentCards(result, `responses-user-${index}`, 'user_message', item.content)
      return
    }
    if (type === 'function_call' || type === 'custom_tool_call') {
      result.push(toolRequestCard(`responses-tool-request-${index}`, item))
      return
    }
    if (type === 'function_call_output') {
      result.push(toolResultCard(`responses-tool-result-${index}`, item))
      return
    }
    if (typeof item.text === 'string') {
      result.push(textCard(`responses-text-${index}`, 'assistant_text', item.text))
      return
    }
    if (typeof item.thinking === 'string') {
      result.push(textCard(`responses-thinking-${index}`, 'assistant_thinking', item.thinking))
      return
    }
    result.push(rawCard(`responses-raw-${index}`, `未知 Responses 项: ${type || 'unknown'}`, item))
  })

  return result
}

function buildAnthropicCards(body: Record<string, unknown>): MessageFlowCardDescriptor[] {
  const result: MessageFlowCardDescriptor[] = []
  if (typeof body.system === 'string') {
    result.push(textCard('anthropic-system', 'system_message', body.system))
  } else if (Array.isArray(body.system)) {
    pushAnthropicBlocks(result, 'anthropic-system', 'system_message', body.system)
  } else if (body.system !== undefined) {
    result.push(rawCard('anthropic-system-raw', 'System', body.system))
  }

  arrayOfRecords(body.messages).forEach((message, index) => {
    const role = String(message.role ?? 'user')
    if (typeof message.content === 'string') {
      result.push(textCard(`anthropic-${role}-${index}`, role === 'assistant' ? 'assistant_text' : 'user_message', message.content))
      return
    }
    if (Array.isArray(message.content)) {
      pushAnthropicBlocks(result, `anthropic-${role}-${index}`, role === 'assistant' ? 'assistant_text' : 'user_message', message.content)
      return
    }
    result.push(rawCard(`anthropic-raw-${index}`, `未知 Anthropic 消息: ${role}`, message))
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
  <div class="msg-flow">
    <div v-for="card in cards" :key="card.id" class="msg-flow-item" :class="`flow-${card.type}`">
      <component :is="componentFor(card.type)" v-bind="card.props" />
    </div>
  </div>
</template>

<style scoped>
.msg-flow {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  max-width: 100%;
  padding: 12px 14px 16px 24px;
  border-left: 2px solid var(--border);
  margin-left: 4px;
}

.msg-flow-item {
  position: relative;
  min-width: 0;
}

.msg-flow-item::before {
  content: '';
  position: absolute;
  left: -30px;
  top: 14px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--border);
  z-index: 1;
}

.flow-system_message::before { background: #9e9e9e; }
.flow-user_message::before { background: #ab47bc; }
.flow-assistant_text::before { background: #66bb6a; }
.flow-assistant_thinking::before { background: #42a5f5; }
.flow-tool_call_request::before { background: #4338ca; }
.flow-tool_call_result::before { background: #7b1fa2; }
.flow-message_meta::before { background: #ff9800; }
.flow-tools_list::before { background: #ef5350; }
.flow-raw_json::before { background: #78909c; }
</style>
