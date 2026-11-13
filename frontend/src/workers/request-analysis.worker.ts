/// <reference lib="webworker" />

import { analyzeRequestContext } from '../context-composition'
import type { ApiEndpoint } from '../types'
import { formatErrorChain } from '../error'

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

