import {
  MergedResponse,
  OpenAIResponsesMergedResponse,
  AnthropicMergedResponse,
  ApiEndpoint,
  SSEChunk,
} from './types';
import { parseSSEText } from './sse-parser';
import { getEndpointDefinition } from './endpoints';

export function parseSSE(rawText: string): SSEChunk[] {
  return parseSSEText(rawText);
}

export function mergeChunks(chunks: SSEChunk[], endpoint: ApiEndpoint): MergedContentResult | null {
  switch (endpoint) {
    case 'openai-chat':
    case 'openai-responses':
    case 'anthropic-messages': {
      const accumulator = getEndpointDefinition(endpoint).createAccumulator();
      for (const chunk of chunks) accumulator.accept(chunk);
      return accumulator.final();
    }
  }
  return assertNever(endpoint);
}

type MergedContentResult = MergedResponse | OpenAIResponsesMergedResponse | AnthropicMergedResponse;

function assertNever(value: never): never {
  throw new Error(`未实现的 endpoint: ${String(value)}`);
}
