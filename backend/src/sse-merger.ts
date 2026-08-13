import {
  MergedResponse,
  OpenAIResponsesMergedResponse,
  AnthropicMergedResponse,
  ApiEndpoint,
  SSEChunk,
} from './types';
import { parseSSEText, parseSSETextWithMetadata, SSEParseResult } from './sse-parser';
import { getEndpointDefinition } from './endpoints';

export function parseSSE(rawText: string): SSEChunk[] {
  return parseSSEText(rawText);
}

export function parseSSEWithMetadata(rawText: string): SSEParseResult {
  return parseSSETextWithMetadata(rawText);
}

export function isTerminalSSE(result: SSEParseResult, endpoint: ApiEndpoint): boolean {
  switch (endpoint) {
    case 'openai-chat':
      return result.done || result.chunks.some(chunk => hasChatFinishReason(chunk.data));
    case 'openai-responses':
      return result.chunks.some(chunk => isResponsesTerminal(chunk.data));
    case 'anthropic-messages':
      return result.chunks.some(chunk => eventType(chunk) === 'message_stop');
    case 'passthrough':
      return true;
  }
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
    case 'passthrough':
      return null;
  }
}

type MergedContentResult = MergedResponse | OpenAIResponsesMergedResponse | AnthropicMergedResponse;

function hasChatFinishReason(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.choices)) return false;
  return value.choices.some(choice => isRecord(choice) && choice.finish_reason != null);
}

function isResponsesTerminal(value: unknown): boolean {
  const type = eventType({ data: value });
  return type === 'response.completed'
    || type === 'response.failed'
    || type === 'response.incomplete'
    || type === 'response.error'
    || type === 'error';
}

function eventType(chunk: Pick<SSEChunk, 'event' | 'data'>): string | undefined {
  if (isRecord(chunk.data) && typeof chunk.data.type === 'string') return chunk.data.type;
  return chunk.event;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
