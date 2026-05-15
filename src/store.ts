import { EventEmitter } from 'events';
import { RecordedRequest, RecordSummary } from './types';

const records = new Map<string, RecordedRequest>();
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

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
    const rc = r.responseContent as { choices?: { message?: { content?: string; reasoning_content?: string } }[] } | null;
    const msg = rc?.choices?.[0]?.message;
    preview = msg?.content ?? msg?.reasoning_content ?? '';
  }
  if (!preview && r.error) preview = r.error;

  return {
    id: r.id,
    timestamp: r.timestamp,
    model,
    status: r.responseStatus,
    preview: preview.slice(0, 80),
    streaming: r.streaming,
    durationMs: r.durationMs,
    state: r.state,
    apiType: r.apiType,
  };
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

export function size(): number {
  return records.size;
}

export function onUpdate(cb: (summary: RecordSummary) => void): () => void {
  emitter.on('update', cb);
  return () => emitter.off('update', cb);
}

export function onClear(cb: () => void): () => void {
  emitter.on('clear', cb);
  return () => emitter.off('clear', cb);
}

