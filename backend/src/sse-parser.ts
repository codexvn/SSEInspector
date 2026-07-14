import { createParser } from 'eventsource-parser';
import { SSEChunk } from './types';

export interface SSEParseResult {
  chunks: SSEChunk[];
  done: boolean;
}

function formatErrorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current) {
    if (current instanceof Error) {
      messages.push(`${current.name}: ${current.message}`);
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  return messages.join(' -> ');
}

export function parseSSEText(rawText: string): SSEChunk[] {
  return parseSSETextWithMetadata(rawText).chunks;
}

export function parseSSETextWithMetadata(rawText: string): SSEParseResult {
  const chunks: SSEChunk[] = [];
  let done = false;
  const parser = createParser({
    onEvent(event) {
      const data = event.data.trim();
      if (!data) return;
      if (data === '[DONE]') {
        done = true;
        return;
      }

      try {
        chunks.push({ event: event.event, data: JSON.parse(data) });
      } catch (err) {
        console.warn(`[sse-parser] SSE data JSON 解析失败: ${formatErrorChain(err)}`);
      }
    },
    onError(error) {
      console.warn(`[sse-parser] SSE 解析失败: ${formatErrorChain(error)}`);
    },
  });

  parser.feed(rawText);
  parser.reset({ consume: true });

  return { chunks, done };
}
