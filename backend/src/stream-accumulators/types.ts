import { SSEChunk } from '../types';

export interface StreamAccumulator<T> {
  accept(chunk: SSEChunk): void;
  final(): T | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function mergeDefinedFields<T extends Record<string, unknown>>(
  current: T | undefined,
  incoming: Record<string, unknown> | undefined,
): T | undefined {
  if (!incoming) return current;

  const merged: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) merged[key] = value;
  }

  return merged as T;
}

export function formatErrorChain(error: unknown): string {
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
