import { createParser } from 'eventsource-parser';
import { SSEChunk } from './types';
import { getLogger, serializeError } from './logger';

const logger = getLogger('sse-parser');

export interface SSEParseResult {
  chunks: SSEChunk[];
  done: boolean;
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
        logger.warn({ err: serializeError(err) }, 'SSE data JSON parsing failed');
      }
    },
    onError(error) {
      logger.warn({ err: serializeError(error) }, 'SSE parsing failed');
    },
  });

  parser.feed(rawText);
  parser.reset({ consume: true });

  return { chunks, done };
}
