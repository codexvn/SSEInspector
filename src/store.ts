import { EventEmitter } from 'events';
import { RecordedRequest, RecordSummary } from './types';

const records = new Map<string, RecordedRequest>();
const emitter = new EventEmitter();
emitter.setMaxListeners(100);
const MAX_SEARCH_TEXT_LENGTH = 50000;

function toSummary(r: RecordedRequest): RecordSummary {
  const model = r.responseContent?.model ?? (r.requestBody as Record<string, unknown>)?.model as string ?? 'unknown';

  let preview = '';
  if (r.apiType === 'anthropic') {
    const rc = r.responseContent as { content?: { type: string; text?: string; thinking?: string }[] } | null;
    const blocks = rc?.content ?? [];
    for (const b of blocks) {
      if (b.text) { preview = b.text; break; }
      if (b.thinking) { preview = '[thinking] ' + b.thinking; break; }
    }
  } else {
    const rc = r.responseContent as {
      choices?: { message?: { content?: string; reasoning_content?: string } }[];
      output_text?: string;
      reasoning_text?: string;
      output?: unknown[];
    } | null;
    const msg = rc?.choices?.[0]?.message;
    preview = msg?.content ?? msg?.reasoning_content ?? rc?.output_text ?? rc?.reasoning_text ?? '';

    if (!preview && Array.isArray(rc?.output)) {
      preview = extractOutputText(rc.output);
    }
  }
  if (!preview && r.error) preview = r.error;

  return {
    id: r.id,
    timestamp: r.timestamp,
    model,
    status: r.responseStatus,
    preview: preview.slice(0, 80),
    searchText: buildSearchText(r, model, preview),
    streaming: r.streaming,
    durationMs: r.durationMs,
    state: r.state,
    apiType: r.apiType,
    streamText: r.streamText,
  };
}

function buildSearchText(r: RecordedRequest, model: string, preview: string): string {
  const parts = [
    r.id,
    r.method,
    r.path,
    r.upstreamUrl,
    r.apiType,
    String(r.responseStatus),
    r.state,
    model,
    preview,
    r.error ?? '',
    stringifyForSearch(r.requestBody),
    stringifyForSearch(r.responseContent),
    r.responseBody ?? '',
  ];

  return parts
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_SEARCH_TEXT_LENGTH)
    .toLowerCase();
}

function stringifyForSearch(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractOutputText(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue;
    const typedItem = item as { text?: string; content?: unknown[] };
    if (typeof typedItem.text === 'string') parts.push(typedItem.text);
    if (!Array.isArray(typedItem.content)) continue;
    for (const content of typedItem.content) {
      if (typeof content !== 'object' || content === null) continue;
      const typedContent = content as { text?: string };
      if (typeof typedContent.text === 'string') parts.push(typedContent.text);
    }
  }
  return parts.join('');
}

export function upsertRecord(r: RecordedRequest): void {
  records.set(r.id, r);
  emitter.emit('update', toSummary(r));
}

export function getAll(): RecordSummary[] {
  const results: RecordSummary[] = [];
  for (const r of records.values()) {
    results.push(toSummary(r));
  }
  results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return results;
}

export function getById(id: string): RecordedRequest | undefined {
  return records.get(id);
}

export function clear(): void {
  records.clear();
  emitter.emit('clear');
}

export function onUpdate(cb: (summary: RecordSummary) => void): () => void {
  emitter.on('update', cb);
  return () => emitter.off('update', cb);
}

export function onClear(cb: () => void): () => void {
  emitter.on('clear', cb);
  return () => emitter.off('clear', cb);
}

