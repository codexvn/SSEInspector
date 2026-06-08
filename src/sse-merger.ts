import {
  MergedResponse, MergedToolCall,
  OpenAIResponsesMergedResponse,
  AnthropicMergedResponse, AnthropicContentBlock,
  ApiType, SSEChunk,
} from './types';

// ---- OpenAI ----

interface OpenAIDelta {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: {
    index: number;
    delta?: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: {
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface OpenAIResponsesEvent {
  type?: string;
  sequence_number?: number;
  response?: {
    id?: string;
    object?: string;
    created?: number;
    created_at?: number;
    model?: string;
    status?: string;
    output?: unknown[];
    output_text?: string;
    usage?: Record<string, unknown>;
  };
  item?: {
    id?: string;
    type?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
  };
  output_index?: number;
  content_index?: number;
  delta?: string;
  text?: string;
  arguments?: string;
}

function parseOpenAISSE(rawText: string): SSEChunk[] {
  const events = rawText.split(/\r?\n\r?\n/);
  const chunks: SSEChunk[] = [];

  for (const event of events) {
    const lines = event.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        chunks.push({ data: JSON.parse(data) });
      } catch { /* skip */ }
    }
  }
  return chunks;
}

function mergeOpenAIDeltas(deltas: OpenAIDelta[]): MergedResponse | null {
  if (deltas.length === 0) return null;

  const merged: MergedResponse = { id: '', object: '', created: 0, model: '', choices: [] };

  for (const delta of deltas) {
    if (delta.id) merged.id = delta.id;
    if (delta.object) merged.object = delta.object;
    if (delta.created) merged.created = delta.created;
    if (delta.model) merged.model = delta.model;
    if (delta.usage) merged.usage = delta.usage;

    for (const cc of delta.choices ?? []) {
      const idx = cc.index;
      if (!merged.choices[idx]) {
        merged.choices[idx] = { index: idx, message: { role: '', content: '' }, finish_reason: null };
      }
      const target = merged.choices[idx];
      const d = cc.delta ?? {};

      if (d.role) target.message.role = d.role;
      if (d.content != null) target.message.content += d.content;
      if (d.reasoning_content != null) {
        target.message.reasoning_content ??= '';
        target.message.reasoning_content += d.reasoning_content;
      }
      if (d.tool_calls) {
        target.message.tool_calls ??= [];
        for (const tcDelta of d.tool_calls) {
          if (!target.message.tool_calls[tcDelta.index]) {
            target.message.tool_calls[tcDelta.index] = { index: tcDelta.index, function: { arguments: '' } };
          }
          const tc: MergedToolCall = target.message.tool_calls[tcDelta.index];
          if (tcDelta.id) tc.id = tcDelta.id;
          if (tcDelta.type) tc.type = tcDelta.type;
          if (tcDelta.function?.name) tc.function.name = tcDelta.function.name;
          if (tcDelta.function?.arguments != null) tc.function.arguments += tcDelta.function.arguments;
        }
      }
      if (cc.finish_reason != null) target.finish_reason = cc.finish_reason;
    }
  }
  return merged;
}

function isOpenAIResponsesEvent(data: unknown): data is OpenAIResponsesEvent {
  return typeof data === 'object'
    && data !== null
    && typeof (data as OpenAIResponsesEvent).type === 'string'
    && (data as OpenAIResponsesEvent).type!.startsWith('response.');
}

function extractResponseOutputText(output: unknown): string {
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];

  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue;
    const typedItem = item as { type?: string; content?: unknown[]; text?: string };

    if (typeof typedItem.text === 'string') {
      parts.push(typedItem.text);
    }

    if (Array.isArray(typedItem.content)) {
      for (const content of typedItem.content) {
        if (typeof content !== 'object' || content === null) continue;
        const typedContent = content as { type?: string; text?: string };
        if (typeof typedContent.text === 'string') {
          parts.push(typedContent.text);
        }
      }
    }
  }

  return parts.join('');
}

function mergeOpenAIResponsesEvents(events: OpenAIResponsesEvent[]): OpenAIResponsesMergedResponse | null {
  if (events.length === 0) return null;

  const merged: OpenAIResponsesMergedResponse = {
    id: '',
    object: 'response',
    model: '',
    output_text: '',
    reasoning_text: '',
    tool_calls: [],
  };

  for (const ev of events) {
    if (ev.response) {
      if (ev.response.id) merged.id = ev.response.id;
      if (ev.response.object) merged.object = ev.response.object;
      if (ev.response.created !== undefined) merged.created = ev.response.created;
      if (ev.response.created_at !== undefined) merged.created_at = ev.response.created_at;
      if (ev.response.model) merged.model = ev.response.model;
      if (ev.response.status) merged.status = ev.response.status;
      if (ev.response.usage) merged.usage = ev.response.usage;
      if (ev.response.output) {
        merged.output = ev.response.output;
        const outputText = extractResponseOutputText(ev.response.output);
        if (outputText) merged.output_text = outputText;
      }
      if (ev.response.output_text) merged.output_text = ev.response.output_text;
    }

    switch (ev.type) {
      case 'response.output_text.delta':
        merged.output_text = (merged.output_text || '') + (ev.delta || '');
        break;
      case 'response.output_text.done':
        if (ev.text && (!merged.output_text || merged.output_text.length < ev.text.length)) {
          merged.output_text = ev.text;
        }
        break;
      case 'response.reasoning_text.delta':
      case 'response.reasoning.delta':
        merged.reasoning_text = (merged.reasoning_text || '') + (ev.delta || '');
        break;
      case 'response.reasoning_text.done':
        if (ev.text && (!merged.reasoning_text || merged.reasoning_text.length < ev.text.length)) {
          merged.reasoning_text = ev.text;
        }
        break;
      case 'response.function_call_arguments.delta': {
        const index = ev.output_index ?? 0;
        if (!merged.tool_calls) merged.tool_calls = [];
        if (!merged.tool_calls[index]) {
          merged.tool_calls[index] = { index, function: { arguments: '' } };
        }
        merged.tool_calls[index].function.arguments += ev.delta || '';
        break;
      }
      case 'response.function_call_arguments.done': {
        const index = ev.output_index ?? 0;
        if (!merged.tool_calls) merged.tool_calls = [];
        if (!merged.tool_calls[index]) {
          merged.tool_calls[index] = { index, function: { arguments: '' } };
        }
        if (ev.arguments) merged.tool_calls[index].function.arguments = ev.arguments;
        break;
      }
      case 'response.output_item.added':
      case 'response.output_item.done': {
        if (ev.item?.type === 'function_call') {
          const index = ev.output_index ?? merged.tool_calls?.length ?? 0;
          if (!merged.tool_calls) merged.tool_calls = [];
          if (!merged.tool_calls[index]) {
            merged.tool_calls[index] = { index, function: { arguments: '' } };
          }
          const toolCall = merged.tool_calls[index];
          if (ev.item.id || ev.item.call_id) toolCall.id = ev.item.id || ev.item.call_id;
          toolCall.type = ev.item.type;
          if (ev.item.name) toolCall.function.name = ev.item.name;
          if (ev.item.arguments) toolCall.function.arguments = ev.item.arguments;
        }
        break;
      }
    }
  }

  if (!merged.reasoning_text) delete merged.reasoning_text;
  if (!merged.tool_calls?.length) delete merged.tool_calls;

  return merged;
}

// ---- Anthropic ----

interface AnthropicSSEEvent {
  type: string;
  message?: {
    id: string;
    model: string;
    role: string;
    content: unknown[];
    stop_reason: string | null;
    stop_sequence: string | null;
    usage: { input_tokens: number; output_tokens: number };
  };
  content_block?: {
    type: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: unknown;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
    stop_sequence?: string;
  };
  index?: number;
  usage?: { output_tokens: number };
}

function parseAnthropicSSE(rawText: string): SSEChunk[] {
  // Anthropic SSE uses \n\n to separate events, with optional "event:" line
  const eventBlocks = rawText.split(/\r?\n\r?\n/);
  const chunks: SSEChunk[] = [];

  for (const block of eventBlocks) {
    const lines = block.split(/\r?\n/);
    let eventType: string | undefined;
    let dataLine: string | undefined;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('event:')) {
        eventType = trimmed.slice(6).trim();
      } else if (trimmed.startsWith('data:')) {
        dataLine = trimmed.slice(5).trim();
      }
    }

    if (dataLine) {
      try {
        chunks.push({ event: eventType, data: JSON.parse(dataLine) });
      } catch { /* skip */ }
    }
  }

  return chunks;
}

function mergeAnthropicEvents(chunks: SSEChunk[]): AnthropicMergedResponse | null {
  if (chunks.length === 0) return null;

  const merged: AnthropicMergedResponse = {
    id: '',
    model: '',
    role: '',
    content: [],
    stop_reason: null,
    stop_sequence: null,
  };

  for (const chunk of chunks) {
    const ev = chunk.data as AnthropicSSEEvent;

    switch (ev.type) {
      case 'message_start': {
        if (ev.message) {
          merged.id = ev.message.id;
          merged.model = ev.message.model;
          merged.role = ev.message.role;
          merged.usage = ev.message.usage;
        }
        break;
      }
      case 'content_block_start': {
        if (ev.content_block && ev.index !== undefined) {
          const cb = ev.content_block;
          const block: AnthropicContentBlock = {
            type: cb.type as AnthropicContentBlock['type'],
            index: ev.index,
          };

          if (cb.type === 'text') {
            block.text = cb.text || '';
          } else if (cb.type === 'thinking') {
            block.thinking = cb.thinking || '';
          } else if (cb.type === 'tool_use') {
            block.id = cb.id;
            block.name = cb.name;
            block.input = cb.input || {};
          }

          merged.content[ev.index] = block;
        }
        break;
      }
      case 'content_block_delta': {
        if (ev.delta && ev.index !== undefined) {
          const block = merged.content[ev.index];
          if (!block) break;
          const d = ev.delta;

          if (d.type === 'text_delta' && block.type === 'text') {
            block.text = (block.text || '') + (d.text || '');
          } else if (d.type === 'thinking_delta' && block.type === 'thinking') {
            block.thinking = (block.thinking || '') + (d.thinking || '');
          } else if (d.type === 'input_json_delta' && block.type === 'tool_use') {
            const partial = d.partial_json || '';
            // Accumulate raw JSON and try to parse
            const raw = (block as unknown as Record<string, unknown>)._input_raw as string || '';
            const newRaw = raw + partial;
            (block as unknown as Record<string, unknown>)._input_raw = newRaw;
            try {
              block.input = JSON.parse(newRaw);
            } catch {
              block.input = newRaw;
            }
          }
        }
        break;
      }
      case 'message_delta': {
        if (ev.delta) {
          if (ev.delta.stop_reason != null) merged.stop_reason = ev.delta.stop_reason as string;
          if (ev.delta.stop_sequence != null) merged.stop_sequence = ev.delta.stop_sequence as string;
        }
        if (ev.usage) {
          merged.usage = { ...merged.usage!, output_tokens: ev.usage.output_tokens };
        }
        break;
      }
      // content_block_stop, message_stop, ping — no merge action needed
    }
  }

  // Clean up _input_raw internal field from blocks
  for (const block of merged.content) {
    delete (block as unknown as Record<string, unknown>)._input_raw;
  }

  return merged;
}

// ---- Unified ----

export function parseSSE(rawText: string, apiType: ApiType): SSEChunk[] {
  return apiType === 'anthropic' ? parseAnthropicSSE(rawText) : parseOpenAISSE(rawText);
}

export function mergeChunks(chunks: SSEChunk[], apiType: ApiType): MergedResponse | OpenAIResponsesMergedResponse | AnthropicMergedResponse | null {
  if (apiType === 'anthropic') {
    return mergeAnthropicEvents(chunks);
  }
  if (chunks.some(c => isOpenAIResponsesEvent(c.data))) {
    return mergeOpenAIResponsesEvents(chunks.map(c => c.data as OpenAIResponsesEvent));
  }
  return mergeOpenAIDeltas(chunks.map(c => c.data as OpenAIDelta));
}
