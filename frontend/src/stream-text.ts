import type { ApiEndpoint } from './types'
import { formatErrorChain } from './error'

export class IncrementalSseTextExtractor {
  private readonly endpoint: ApiEndpoint
  private previousRaw = ''
  private pendingLine = ''
  private output = ''

  constructor(endpoint: ApiEndpoint) {
    this.endpoint = endpoint
  }

  accept(raw: string): string {
    if (!raw.startsWith(this.previousRaw)) this.reset()
    const suffix = raw.slice(this.previousRaw.length)
    this.previousRaw = raw
    if (!suffix) return this.output

    const lines = (this.pendingLine + suffix).split('\n')
    this.pendingLine = lines.pop() ?? ''
    for (const line of lines) this.acceptLine(line.endsWith('\r') ? line.slice(0, -1) : line)
    return this.output
  }

  private reset(): void {
    this.previousRaw = ''
    this.pendingLine = ''
    this.output = ''
  }

  private acceptLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') return

    let event: Record<string, unknown>
    try {
      event = JSON.parse(data) as Record<string, unknown>
    } catch (error) {
      console.warn(`[stream-text] SSE data JSON 解析失败: ${formatErrorChain(error)}`)
      return
    }

    switch (this.endpoint) {
      case 'openai-chat':
        this.appendOpenAIChat(event)
        return
      case 'openai-responses':
        if (typeof event.type === 'string'
          && event.type.endsWith('output_text.delta')
          && typeof event.delta === 'string') {
          this.output += event.delta
        }
        return
      case 'anthropic-messages':
        if (event.type === 'content_block_delta') {
          const delta = event.delta as { text?: string; thinking?: string } | undefined
          if (typeof delta?.text === 'string') this.output += delta.text
          if (typeof delta?.thinking === 'string') this.output += delta.thinking
        }
        return
    }
  }

  private appendOpenAIChat(event: Record<string, unknown>): void {
    const choices = event.choices as Array<{ delta?: { content?: string } }> | undefined
    if (!Array.isArray(choices)) return
    for (const choice of choices) {
      if (typeof choice?.delta?.content === 'string') this.output += choice.delta.content
    }
  }
}
