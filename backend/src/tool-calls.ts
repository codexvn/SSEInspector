import { ApiEndpoint, MergedContent } from './types';

export interface ToolCallCandidate {
  callId: string;
  callIdSource: 'call_id' | 'id';
  itemId?: string;
  name: string;
  arguments?: string;
  kind: 'function' | 'custom' | 'anthropic' | 'tool_search';
}

export interface ToolOutputCandidate {
  callId: string;
  result: string;
}

export function extractToolCalls(response: MergedContent | null, endpoint: ApiEndpoint): ToolCallCandidate[] {
  if (!isRecord(response)) return [];
  switch (endpoint) {
    case 'openai-chat':
      return extractChatToolCalls(response);
    case 'openai-responses':
      return extractResponsesToolCalls(response);
    case 'anthropic-messages':
      return extractAnthropicToolCalls(response);
    case 'passthrough':
      return [];
  }
}

export function extractToolOutputs(requestBody: unknown, endpoint: ApiEndpoint): ToolOutputCandidate[] {
  if (!isRecord(requestBody)) return [];
  switch (endpoint) {
    case 'openai-chat':
      return extractChatToolOutputs(requestBody.messages);
    case 'openai-responses':
      return extractResponsesToolOutputs(requestBody.input);
    case 'anthropic-messages':
      return extractAnthropicToolOutputs(requestBody.messages ?? requestBody.input);
    case 'passthrough':
      return [];
  }
}

function extractChatToolCalls(response: Record<string, unknown>): ToolCallCandidate[] {
  const result: ToolCallCandidate[] = [];
  for (const choice of records(response.choices)) {
    const message = isRecord(choice.message) ? choice.message : undefined;
    for (const toolCall of records(message?.tool_calls)) {
      const id = stringValue(toolCall.id);
      if (!id) continue;
      const fn = isRecord(toolCall.function) ? toolCall.function : undefined;
      result.push({
        callId: id,
        callIdSource: 'id',
        itemId: id,
        name: stringValue(fn?.name) ?? '',
        arguments: serializeOptional(fn?.arguments),
        kind: 'function',
      });
    }
  }
  return result;
}

function extractResponsesToolCalls(response: Record<string, unknown>): ToolCallCandidate[] {
  const result: ToolCallCandidate[] = [];
  for (const item of records(response.output)) {
    const type = stringValue(item.type);
    if (type !== 'function_call' && type !== 'custom_tool_call' && type !== 'tool_search_call') continue;
    const callId = stringValue(item.call_id);
    const itemId = stringValue(item.id);
    const pairedId = callId ?? itemId;
    if (!pairedId) continue;
    result.push({
      callId: pairedId,
      callIdSource: callId ? 'call_id' : 'id',
      itemId,
      name: stringValue(item.name) ?? (type === 'tool_search_call' ? 'tool_search' : ''),
      arguments: serializeOptional(type === 'custom_tool_call' ? item.input : item.arguments),
      kind: type === 'custom_tool_call' ? 'custom' : type === 'tool_search_call' ? 'tool_search' : 'function',
    });
  }
  return result;
}

function extractAnthropicToolCalls(response: Record<string, unknown>): ToolCallCandidate[] {
  const result: ToolCallCandidate[] = [];
  for (const block of records(response.content)) {
    if (block.type !== 'tool_use') continue;
    const id = stringValue(block.id);
    if (!id) continue;
    result.push({
      callId: id,
      callIdSource: 'id',
      itemId: id,
      name: stringValue(block.name) ?? '',
      arguments: serializeOptional(block.input),
      kind: 'anthropic',
    });
  }
  return result;
}

function extractChatToolOutputs(value: unknown): ToolOutputCandidate[] {
  const result: ToolOutputCandidate[] = [];
  for (const message of records(value)) {
    if (message.role !== 'tool') continue;
    const callId = stringValue(message.tool_call_id);
    if (callId) result.push({ callId, result: serialize(message.content) });
  }
  return result;
}

function extractResponsesToolOutputs(value: unknown): ToolOutputCandidate[] {
  const result: ToolOutputCandidate[] = [];
  for (const item of records(value)) {
    const type = stringValue(item.type);
    if (type !== 'function_call_output' && type !== 'custom_tool_call_output' && type !== 'tool_search_output') continue;
    const callId = stringValue(item.call_id) ?? stringValue(item.id);
    if (!callId) continue;
    result.push({ callId, result: serialize(item.output ?? item.content) });
  }
  return result;
}

function extractAnthropicToolOutputs(value: unknown): ToolOutputCandidate[] {
  const result: ToolOutputCandidate[] = [];
  for (const message of records(value)) {
    for (const block of records(message.content)) {
      if (block.type !== 'tool_result') continue;
      const callId = stringValue(block.tool_use_id);
      if (callId) result.push({ callId, result: serialize(block.content) });
    }
  }
  return result;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function serializeOptional(value: unknown): string | undefined {
  return value === undefined ? undefined : serialize(value);
}

function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  return value === undefined ? 'null' : JSON.stringify(value);
}
