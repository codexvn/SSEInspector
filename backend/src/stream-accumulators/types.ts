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
