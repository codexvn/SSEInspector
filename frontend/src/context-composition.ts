import type { ApiEndpoint } from './types'

export type ContextCompositionKind =
  | 'instructions'
  | 'user'
  | 'assistant'
  | 'tool_definitions'
  | 'tool_interactions'
  | 'attachments'
  | 'other'

export interface ContextCompositionPart {
  kind: ContextCompositionKind
  bytes: number
  ratio: number
}

export interface RequestContextAnalysis {
  model: string
  latestUserMessage: string
  summary: string
  totalBytes: number
  parts: ContextCompositionPart[]
}

const KINDS: ContextCompositionKind[] = [
  'instructions',
  'user',
  'assistant',
  'tool_definitions',
  'tool_interactions',
  'attachments',
  'other',
]
const TEXT_TYPES = new Set(['text', 'input_text', 'output_text', 'thinking', 'summary_text', 'reasoning_text'])
const ATTACHMENT_TYPES = new Set(['image', 'input_image', 'image_url', 'file', 'input_file', 'document'])
const TOOL_TYPES = new Set([
  'tool_use',
  'tool_result',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'tool_search_call',
  'tool_search_output',
])

export function analyzeRequestContext(rawBody: string | Record<string, unknown>, endpoint: ApiEndpoint): RequestContextAnalysis {
  const body = typeof rawBody === 'string' ? parseBody(rawBody) : rawBody
  const totalBytes = utf8ByteLength(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody))
  const bytes = Object.fromEntries(KINDS.map(kind => [kind, 0])) as Record<ContextCompositionKind, number>
  const add = (kind: ContextCompositionKind, value: unknown) => {
    if (value === undefined) return
    bytes[kind] += utf8ByteLength(JSON.stringify(value))
  }

  add('instructions', body.instructions)
  add('instructions', body.system)
  add('instructions', body.developer)
  add('tool_definitions', body.tools)
  add('tool_definitions', body.functions)

  const source = endpoint === 'openai-responses' ? body.input : body.messages
  let latestUserMessage = ''
  if (endpoint === 'openai-responses' && typeof source === 'string') {
    add('user', source)
    latestUserMessage = source
  } else if (Array.isArray(source)) {
    for (const item of source) classifyInputItem(item, add)
    latestUserMessage = findLatestUserText(source)
  }

  const knownBytes = KINDS
    .filter(kind => kind !== 'other')
    .reduce((total, kind) => total + bytes[kind], 0)
  bytes.other = Math.max(0, totalBytes - knownBytes)
  const measuredTotal = KINDS.reduce((total, kind) => total + bytes[kind], 0)

  return {
    model: typeof body.model === 'string' ? body.model : 'unknown',
    latestUserMessage,
    summary: buildSummary(body),
    totalBytes,
    parts: buildParts(bytes, measuredTotal),
  }
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function classifyInputItem(
  value: unknown,
  add: (kind: ContextCompositionKind, value: unknown) => void,
): void {
  if (typeof value === 'string') {
    add('user', value)
    return
  }
  if (!isRecord(value)) return
  const type = typeof value.type === 'string' ? value.type : undefined
  if (type && TOOL_TYPES.has(type)) {
    add('tool_interactions', value)
    return
  }
  if (type && ATTACHMENT_TYPES.has(type)) {
    add('attachments', value)
    return
  }
  if (type === 'reasoning') {
    add('assistant', value)
    return
  }
  if (value.role === 'tool' || value.role === 'function') {
    add('tool_interactions', value)
    return
  }

  const roleKind = roleToKind(value.role)
  classifyContent(value.content, roleKind, add)
  add('tool_interactions', value.tool_calls)
  add('tool_interactions', value.function_call)
}

function classifyContent(
  content: unknown,
  roleKind: 'instructions' | 'user' | 'assistant',
  add: (kind: ContextCompositionKind, value: unknown) => void,
): void {
  if (content === undefined) return
  if (typeof content === 'string') {
    add(roleKind, content)
    return
  }
  if (!Array.isArray(content)) {
    add(roleKind, content)
    return
  }
  for (const block of content) {
    if (!isRecord(block)) {
      add(roleKind, block)
      continue
    }
    const type = typeof block.type === 'string' ? block.type : undefined
    if (type && ATTACHMENT_TYPES.has(type)) add('attachments', block)
    else if (type && TOOL_TYPES.has(type)) add('tool_interactions', block)
    else add(roleKind, block)
  }
}

function findLatestUserText(source: unknown[]): string {
  for (let index = source.length - 1; index >= 0; index--) {
    const item = source[index]
    if (!isRecord(item) || item.role !== 'user') continue
    const parts = extractReadableText(item.content)
    if (parts.length > 0) return parts.join('\n')
  }
  return ''
}

function extractReadableText(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value] : []
  if (Array.isArray(value)) return value.flatMap(extractReadableText)
  if (!isRecord(value)) return []
  const type = typeof value.type === 'string' ? value.type : undefined
  if (type && !TEXT_TYPES.has(type)) return []
  const direct = [value.text, value.input_text, value.output_text, value.thinking]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
  return direct.length > 0 ? direct : extractReadableText(value.content)
}

function roleToKind(role: unknown): 'instructions' | 'user' | 'assistant' {
  if (role === 'system' || role === 'developer') return 'instructions'
  if (role === 'assistant') return 'assistant'
  return 'user'
}

function buildSummary(body: Record<string, unknown>): string {
  const parts: string[] = []
  if (body.model !== undefined) parts.push(`model: ${String(body.model)}`)
  if (typeof body.stream === 'boolean') parts.push(`stream: ${body.stream ? 'true' : 'false'}`)
  if (body.max_tokens !== undefined) parts.push(`max_tokens: ${String(body.max_tokens)}`)
  if (body.max_output_tokens !== undefined) parts.push(`max_output_tokens: ${String(body.max_output_tokens)}`)
  const tools = Array.isArray(body.tools) ? body.tools.length : 0
  if (tools > 0) parts.push(`tools: ${tools}`)
  return parts.join('  ')
}

function buildParts(
  bytes: Record<ContextCompositionKind, number>,
  total: number,
): ContextCompositionPart[] {
  if (total <= 0) return KINDS.map(kind => ({ kind, bytes: bytes[kind], ratio: 0 }))
  const exact = KINDS.map(kind => ({ kind, bytes: bytes[kind], exact: bytes[kind] / total * 100 }))
  const ratios = exact.map(part => Math.floor(part.exact))
  let remaining = 100 - ratios.reduce((sum, ratio) => sum + ratio, 0)
  const order = exact
    .map((part, index) => ({ index, fraction: part.exact - Math.floor(part.exact) }))
    .sort((left, right) => right.fraction - left.fraction)
  for (let index = 0; index < remaining; index++) ratios[order[index % order.length].index] += 1
  return exact.map((part, index) => ({ kind: part.kind, bytes: part.bytes, ratio: ratios[index] }))
}

function parseBody(rawBody: string): Record<string, unknown> {
  const value = JSON.parse(rawBody) as unknown
  if (!isRecord(value)) throw new Error('请求体不是 JSON 对象')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
