import { createParser } from 'eventsource-parser';
import { SSEChunk } from './types';

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
  const chunks: SSEChunk[] = [];
  const parser = createParser({
    onEvent(event) {
      const data = event.data.trim();
      if (!data || data === '[DONE]') return;

      try {
        chunks.push({ event: event.event, data: JSON.parse(data) });
      } catch (err) {
        console.warn(`[sse-parser] SSE data JSON 解析失败: ${formatErrorChain(err)} data=${data.slice(0, 500)}`);
      }
    },
    onError(error) {
      console.warn(`[sse-parser] SSE 解析失败: ${formatErrorChain(error)}`);
    },
  });

  parser.feed(rawText);
  parser.reset({ consume: true });

  return chunks;
}
