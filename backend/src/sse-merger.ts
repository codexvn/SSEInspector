import {
  MergedResponse,
  OpenAIResponsesMergedResponse,
  AnthropicMergedResponse,
  ApiType,
  SSEChunk,
} from './types';
import { parseSSEText } from './sse-parser';
import { AnthropicAccumulator } from './stream-accumulators/anthropic';
import { OpenAIChatAccumulator } from './stream-accumulators/openai-chat';
import { OpenAIResponsesAccumulator, isOpenAIResponsesEvent } from './stream-accumulators/openai-responses';

export function parseSSE(rawText: string, _apiType: ApiType): SSEChunk[] {
  return parseSSEText(rawText);
}

export function mergeChunks(
  chunks: SSEChunk[], apiType: ApiType,
): MergedResponse | OpenAIResponsesMergedResponse | AnthropicMergedResponse | null {
  if (apiType === 'anthropic') {
    const accumulator = new AnthropicAccumulator();
    for (const chunk of chunks) accumulator.accept(chunk);
    return accumulator.final();
  }

  if (chunks.some(chunk => isOpenAIResponsesEvent(chunk.data))) {
    const accumulator = new OpenAIResponsesAccumulator();
    for (const chunk of chunks) accumulator.accept(chunk);
    return accumulator.final();
  }

  const accumulator = new OpenAIChatAccumulator();
  for (const chunk of chunks) accumulator.accept(chunk);
  return accumulator.final();
}
