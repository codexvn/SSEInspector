import {
  MergedResponse, MergedToolCall,
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

export function parseOpenAISSE(rawText: string): SSEChunk[] {
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

export function mergeOpenAIDeltas(deltas: OpenAIDelta[]): MergedResponse | null {
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

export function parseAnthropicSSE(rawText: string): SSEChunk[] {
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

export function mergeAnthropicEvents(chunks: SSEChunk[]): AnthropicMergedResponse | null {
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

export function mergeChunks(chunks: SSEChunk[], apiType: ApiType): MergedResponse | AnthropicMergedResponse | null {
  if (apiType === 'anthropic') {
    return mergeAnthropicEvents(chunks);
  }
  return mergeOpenAIDeltas(chunks.map(c => c.data as OpenAIDelta));
}
