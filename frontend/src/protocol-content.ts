import type { ApiEndpoint } from './types'

const TEXT_TYPES = new Set(['text', 'input_text', 'output_text', 'thinking', 'summary_text', 'reasoning_text'])

export function extractTextParts(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value] : []
  if (Array.isArray(value)) return value.flatMap(extractTextParts)
  if (!isRecord(value)) return []
  const type = typeof value.type === 'string' ? value.type : undefined
  if (!type || TEXT_TYPES.has(type)) {
    const direct = [value.text, value.input_text, value.output_text, value.thinking]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    if (direct.length > 0) return direct
  }
  return extractTextParts(value.content)
}

export function joinTextParts(value: unknown): string {
  return extractTextParts(value).join('\n')
}

export function findLatestUserMessage(body: Record<string, unknown> | undefined, endpoint: ApiEndpoint): string {
  if (!body) return ''
  const source = endpoint === 'openai-responses' ? body.input : body.messages
  if (endpoint === 'openai-responses' && typeof source === 'string') return source
  if (!Array.isArray(source)) return ''
  for (let index = source.length - 1; index >= 0; index--) {
    const item = source[index]
    if (!isRecord(item) || item.role !== 'user') continue
    const text = joinTextParts(item.content ?? item)
    if (text) return text
  }
  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
