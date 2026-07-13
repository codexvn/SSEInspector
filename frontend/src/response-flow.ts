import type { ApiEndpoint } from './types'
import { extractTextParts } from './protocol-content'

export type ResponseCardDescriptor =
  | { id: string; type: 'assistant_text'; text: string }
  | { id: string; type: 'assistant_thinking'; text: string }
  | { id: string; type: 'assistant_refusal'; text: string }
  | { id: string; type: 'tool_call'; callId: string; name: string; arguments?: string }
  | { id: string; type: 'raw_item'; title: string; value: unknown }
  | { id: string; type: 'finish_reason'; value: string }

export function buildResponseCards(
  responseContent: unknown,
  endpoint: ApiEndpoint,
): ResponseCardDescriptor[] {
  const response = isRecord(responseContent) ? responseContent : undefined
  if (!response) return [{ id: 'raw-response', type: 'raw_item', title: '响应内容', value: responseContent }]
  switch (endpoint) {
    case 'openai-chat':
      return buildChatCards(response)
    case 'openai-responses':
      return buildResponsesCards(response)
    case 'anthropic-messages':
      return buildAnthropicCards(response)
  }
  return assertNever(endpoint)
}

function buildChatCards(response: Record<string, unknown>): ResponseCardDescriptor[] {
  const result: ResponseCardDescriptor[] = []
  records(response.choices).forEach((choice, choiceIndex) => {
    const message = isRecord(choice.message) ? choice.message : undefined
    if (!message) {
      result.push(rawCard(`chat-choice-${choiceIndex}`, '未知 Chat choice', choice))
      return
    }
    pushText(result, `chat-thinking-${choiceIndex}`, 'assistant_thinking', message.reasoning_content)
    pushTextParts(result, `chat-text-${choiceIndex}`, 'assistant_text', message.content)
    pushText(result, `chat-refusal-${choiceIndex}`, 'assistant_refusal', message.refusal)
    records(message.tool_calls).forEach((toolCall, toolIndex) => {
      const fn = isRecord(toolCall.function) ? toolCall.function : undefined
      result.push(toolCard(`chat-tool-${choiceIndex}-${toolIndex}`, toolCall.id, fn?.name, fn?.arguments))
    })
    if (typeof choice.finish_reason === 'string') {
      result.push({ id: `chat-finish-${choiceIndex}`, type: 'finish_reason', value: choice.finish_reason })
    }
  })
  return result.length > 0 ? result : [rawCard('chat-response', '未识别的 Chat 响应', response)]
}

function buildResponsesCards(response: Record<string, unknown>): ResponseCardDescriptor[] {
  const output = Array.isArray(response.output) ? response.output : []
  if (output.length > 0) {
    const result: ResponseCardDescriptor[] = []
    output.forEach((item, itemIndex) => {
      if (!isRecord(item)) {
        result.push(rawCard(`responses-item-${itemIndex}`, '未知 Responses item', item))
        return
      }
      const type = stringValue(item.type) ?? 'unknown'
      if (type === 'message') {
        const before = result.length
        records(item.content).forEach((part, partIndex) => {
          if (part.type === 'output_text') pushText(result, `responses-text-${itemIndex}-${partIndex}`, 'assistant_text', part.text)
          else if (part.type === 'refusal') pushText(result, `responses-refusal-${itemIndex}-${partIndex}`, 'assistant_refusal', part.refusal)
          else if (part.type === 'reasoning_text') pushText(result, `responses-reasoning-${itemIndex}-${partIndex}`, 'assistant_thinking', part.text)
          else result.push(rawCard(`responses-content-${itemIndex}-${partIndex}`, `未知 message content: ${String(part.type ?? 'unknown')}`, part))
        })
        if (result.length === before) result.push(rawCard(`responses-message-${itemIndex}`, '空或未知 message', item))
      } else if (type === 'reasoning') {
        const before = result.length
        for (const [collectionName, collection] of [['summary', item.summary], ['content', item.content]] as const) {
          records(collection).forEach((part, partIndex) => {
            if (typeof part.text === 'string') {
              result.push({ id: `responses-${collectionName}-${itemIndex}-${partIndex}`, type: 'assistant_thinking', text: part.text })
            } else {
              result.push(rawCard(`responses-${collectionName}-raw-${itemIndex}-${partIndex}`, `未知 reasoning ${collectionName}`, part))
            }
          })
        }
        if (result.length === before) result.push(rawCard(`responses-reasoning-${itemIndex}`, 'Reasoning 原始数据', item))
      } else if (type === 'function_call' || type === 'custom_tool_call') {
        result.push(toolCard(
          `responses-tool-${itemIndex}`,
          item.call_id ?? item.id,
          item.name,
          type === 'custom_tool_call' ? item.input : item.arguments,
        ))
      } else {
        result.push(rawCard(`responses-item-${itemIndex}`, `Responses item: ${type}`, item))
      }
    })
    return result
  }

  const fallback: ResponseCardDescriptor[] = []
  pushText(fallback, 'responses-reasoning-fallback', 'assistant_thinking', response.reasoning_text)
  pushText(fallback, 'responses-text-fallback', 'assistant_text', response.output_text)
  return fallback.length > 0 ? fallback : [rawCard('responses-response', 'Responses 原始状态', response)]
}

function buildAnthropicCards(response: Record<string, unknown>): ResponseCardDescriptor[] {
  const result: ResponseCardDescriptor[] = []
  records(response.content).forEach((block, index) => {
    if (block.type === 'text') pushText(result, `anthropic-text-${index}`, 'assistant_text', block.text)
    else if (block.type === 'thinking') pushText(result, `anthropic-thinking-${index}`, 'assistant_thinking', block.thinking)
    else if (block.type === 'tool_use') result.push(toolCard(`anthropic-tool-${index}`, block.id, block.name, block.input))
    else result.push(rawCard(`anthropic-block-${index}`, `Anthropic block: ${String(block.type ?? 'unknown')}`, block))
  })
  return result.length > 0 ? result : [rawCard('anthropic-response', '未识别的 Anthropic 响应', response)]
}

function toolCard(
  id: string,
  callIdValue: unknown,
  nameValue: unknown,
  argumentsValue: unknown,
): ResponseCardDescriptor {
  const callId = stringValue(callIdValue) ?? id
  return {
    id,
    type: 'tool_call',
    callId,
    name: stringValue(nameValue) ?? 'tool',
    arguments: serializeOptional(argumentsValue),
  }
}

function pushText(
  result: ResponseCardDescriptor[],
  id: string,
  type: 'assistant_text' | 'assistant_thinking' | 'assistant_refusal',
  value: unknown,
): void {
  if (typeof value === 'string' && value.length > 0) result.push({ id, type, text: value })
}

function pushTextParts(
  result: ResponseCardDescriptor[],
  id: string,
  type: 'assistant_text' | 'assistant_thinking' | 'assistant_refusal',
  value: unknown,
): void {
  extractTextParts(value).forEach((text, index) => result.push({ id: `${id}-${index}`, type, text }))
}

function rawCard(id: string, title: string, value: unknown): ResponseCardDescriptor {
  return { id, type: 'raw_item', title, value }
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function serializeOptional(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value) ?? 'null'
}

function assertNever(value: never): never {
  throw new Error(`未实现的 endpoint: ${String(value)}`)
}
