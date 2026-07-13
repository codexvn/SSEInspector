import { ApiEndpoint } from './types';

const MESSAGE_ROLES = new Set(['user', 'assistant', 'developer', 'system']);
const TEXT_TYPES = new Set(['text', 'input_text', 'output_text', 'thinking', 'summary_text', 'reasoning_text']);
const TOOL_OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'tool_search_output']);

export function extractTextParts(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(extractTextParts);
  if (!isRecord(value)) return [];

  const type = typeof value.type === 'string' ? value.type : undefined;
  const direct: string[] = [];
  if (!type || TEXT_TYPES.has(type)) {
    for (const key of ['text', 'input_text', 'output_text', 'thinking'] as const) {
      const text = value[key];
      if (typeof text === 'string' && text.trim()) direct.push(text);
    }
  }
  if (direct.length > 0) return direct;
  return extractTextParts(value.content);
}

export function joinTextParts(value: unknown): string {
  return extractTextParts(value).join('\n');
}

export function findLatestMessage(body: unknown, endpoint: ApiEndpoint): string {
  if (!isRecord(body)) return '';
  const source = endpoint === 'openai-responses' ? body.input : body.messages;
  if (!Array.isArray(source)) {
    if (endpoint === 'openai-responses' && typeof source === 'string') return source;
    return extractErrorText(body.error);
  }

  for (let index = source.length - 1; index >= 0; index--) {
    const item = source[index];
    if (!isRecord(item) || !isMessage(item, endpoint)) continue;
    const text = joinTextParts(item.content ?? item);
    if (text) return text;
  }

  for (let index = source.length - 1; index >= 0; index--) {
    const item = source[index];
    if (!isRecord(item) || !TOOL_OUTPUT_TYPES.has(String(item.type ?? ''))) continue;
    const output = item.output ?? item.content;
    const text = joinTextParts(output) || serializeStructuredOutput(output);
    if (text) return text;
  }
  return extractErrorText(body.error);
}

function serializeStructuredOutput(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function extractErrorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';
  if (typeof value.message === 'string') return value.message;
  return JSON.stringify(value);
}

export function findLatestUserMessage(body: unknown, endpoint: ApiEndpoint): string {
  if (!isRecord(body)) return '';
  const source = endpoint === 'openai-responses' ? body.input : body.messages;
  if (!Array.isArray(source)) return '';
  for (let index = source.length - 1; index >= 0; index--) {
    const item = source[index];
    if (!isRecord(item) || item.role !== 'user') continue;
    const text = joinTextParts(item.content ?? item);
    if (text) return text;
  }
  return '';
}

function isMessage(item: Record<string, unknown>, endpoint: ApiEndpoint): boolean {
  const role = typeof item.role === 'string' ? item.role : '';
  if (!MESSAGE_ROLES.has(role)) return false;
  return endpoint !== 'openai-responses' || item.type === 'message' || role.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
