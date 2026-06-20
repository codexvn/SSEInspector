import { AnthropicContentBlock, AnthropicMergedResponse, AnthropicUsage, SSEChunk } from '../types';
import { formatErrorChain, isRecord, mergeDefinedFields, StreamAccumulator } from './types';

interface AnthropicSSEEvent {
  type: string;
  message?: {
    id: string;
    model: string;
    role: string;
    content: unknown[];
    stop_reason: string | null;
    stop_sequence: string | null;
    usage?: AnthropicUsage;
  };
  content_block?: {
    type: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: unknown;
    data?: unknown;
    [key: string]: unknown;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    citation?: unknown;
    signature?: string;
    stop_reason?: string;
    stop_sequence?: string | null;
    [key: string]: unknown;
  };
  index?: number;
  usage?: AnthropicUsage;
}

function mergeAnthropicUsage(
  current: AnthropicUsage | undefined,
  incoming: AnthropicUsage | undefined,
): AnthropicUsage | undefined {
  return mergeDefinedFields(current, incoming);
}

export class AnthropicAccumulator implements StreamAccumulator<AnthropicMergedResponse> {
  private hasData = false;
  private readonly merged: AnthropicMergedResponse = {
    id: '',
    model: '',
    role: '',
    content: [],
    stop_reason: null,
    stop_sequence: null,
  };

  accept(chunk: SSEChunk): void {
    if (!isRecord(chunk.data) || typeof chunk.data.type !== 'string') return;
    const event = chunk.data as unknown as AnthropicSSEEvent;

    switch (event.type) {
      case 'message_start':
        this.hasData = true;
        this.mergeMessageStart(event);
        break;
      case 'content_block_start':
        this.hasData = true;
        this.mergeContentBlockStart(event);
        break;
      case 'content_block_delta':
        this.hasData = true;
        this.mergeContentBlockDelta(event);
        break;
      case 'message_delta':
        this.hasData = true;
        this.mergeMessageDelta(event);
        break;
      // content_block_stop, message_stop, ping — no merge action needed
    }
  }

  final(): AnthropicMergedResponse | null {
    if (!this.hasData) return null;

    for (const block of this.merged.content) {
      this.finalizeToolInput(block);
      delete (block as unknown as Record<string, unknown>)._input_raw;
    }

    return this.merged;
  }

  private mergeMessageStart(event: AnthropicSSEEvent): void {
    if (!event.message) return;

    this.merged.id = event.message.id;
    this.merged.model = event.message.model;
    this.merged.role = event.message.role;
    this.merged.usage = mergeAnthropicUsage(this.merged.usage, event.message.usage);
  }

  private mergeContentBlockStart(event: AnthropicSSEEvent): void {
    if (!event.content_block || event.index === undefined) return;

    const source = event.content_block;
    const block: AnthropicContentBlock = {
      ...source,
      type: source.type,
      index: event.index,
    };

    if (source.type === 'text') {
      block.text = source.text || '';
    } else if (source.type === 'thinking') {
      block.thinking = source.thinking || '';
    } else if (source.type === 'tool_use') {
      block.id = source.id;
      block.name = source.name;
      block.input = source.input || {};
    } else if (source.type !== 'redacted_thinking') {
      // 保留未知块原文，便于排查第三方兼容协议。
      block._raw = source;
    }

    this.merged.content[event.index] = block;
  }

  private mergeContentBlockDelta(event: AnthropicSSEEvent): void {
    if (!event.delta || event.index === undefined) return;

    const block = this.merged.content[event.index];
    if (!block) return;

    const delta = event.delta;
    if (delta.type === 'text_delta' && block.type === 'text') {
      block.text = (block.text || '') + (delta.text || '');
    } else if (delta.type === 'thinking_delta' && block.type === 'thinking') {
      block.thinking = (block.thinking || '') + (delta.thinking || '');
    } else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
      this.mergeInputJsonDelta(block, delta.partial_json || '');
    } else if (delta.type === 'citations_delta') {
      block.citations ??= [];
      block.citations.push(delta.citation ?? delta);
    } else if (delta.type === 'signature_delta' && block.type === 'thinking') {
      block.signature = (block.signature || '') + (delta.signature || '');
    } else {
      const record = block as unknown as Record<string, unknown>;
      const deltas = record._deltas as unknown[] | undefined;
      record._deltas = [...(deltas ?? []), delta];
    }
  }

  private mergeInputJsonDelta(block: AnthropicContentBlock, partial: string): void {
    const raw = (block as unknown as Record<string, unknown>)._input_raw as string || '';
    const nextRaw = raw + partial;
    (block as unknown as Record<string, unknown>)._input_raw = nextRaw;
    block.input = nextRaw;
  }

  private finalizeToolInput(block: AnthropicContentBlock): void {
    if (block.type !== 'tool_use') return;

    const raw = (block as unknown as Record<string, unknown>)._input_raw;
    if (typeof raw !== 'string' || !raw) return;

    try {
      block.input = JSON.parse(raw);
    } catch (err) {
      console.warn(`[AnthropicAccumulator] 工具输入 JSON 解析失败: ${formatErrorChain(err)} raw=${raw.slice(0, 500)}`);
      block.input = raw;
    }
  }

  private mergeMessageDelta(event: AnthropicSSEEvent): void {
    if (event.delta) {
      if (event.delta.stop_reason != null) this.merged.stop_reason = event.delta.stop_reason;
      if (event.delta.stop_sequence != null) this.merged.stop_sequence = event.delta.stop_sequence;
    }
    this.merged.usage = mergeAnthropicUsage(this.merged.usage, event.usage);
  }
}
