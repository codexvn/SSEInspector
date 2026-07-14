/// <reference lib="webworker" />

import { analyzeRequestContext } from '../context-composition'
import type { ApiEndpoint } from '../types'

interface AnalyzeRequestMessage {
  generation: number
  recordId: string
  body: string | Record<string, unknown>
  endpoint: ApiEndpoint
}

self.onmessage = (event: MessageEvent<AnalyzeRequestMessage>) => {
  const { generation, recordId, body, endpoint } = event.data
  try {
    self.postMessage({
      generation,
      recordId,
      ok: true,
      analysis: analyzeRequestContext(body, endpoint),
    })
  } catch (error) {
    self.postMessage({ generation, recordId, ok: false, error: formatErrorChain(error) })
  }
}

function formatErrorChain(error: unknown): string {
  const messages: string[] = []
  let current: unknown = error
  while (current) {
    if (current instanceof Error) {
      messages.push(`${current.name}: ${current.message}`)
      current = current.cause
      continue
    }
    messages.push(String(current))
    break
  }
  return messages.join(' -> ')
}
