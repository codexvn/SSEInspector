import { MergedToolCall, OpenAIResponsesMergedResponse, SSEChunk } from '../types';
import { isRecord, mergeDefinedFields, StreamAccumulator } from './types';

export interface OpenAIResponsesEvent {
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
    error?: Record<string, unknown> | null;
    incomplete_details?: Record<string, unknown> | null;
    [key: string]: unknown;
  };
  item?: {
    id?: string;
    type?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
    status?: string;
    role?: string;
    content?: unknown[];
    summary?: unknown[];
    encrypted_content?: string;
    [key: string]: unknown;
  };
  part?: {
    type?: string;
    text?: string;
    [key: string]: unknown;
  };
  output_index?: number;
  content_index?: number;
  delta?: string;
  text?: string;
  arguments?: string;
  error?: Record<string, unknown> | null;
  incomplete_details?: Record<string, unknown> | null;
}

export function isOpenAIResponsesEvent(data: unknown): data is OpenAIResponsesEvent {
  return isRecord(data)
    && typeof data.type === 'string'
    && data.type.startsWith('response.');
}

function extractResponseOutputText(output: unknown): string {
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];

  for (const item of output) {
    if (!isRecord(item)) continue;

    if (typeof item.text === 'string') {
      parts.push(item.text);
    }

    if (Array.isArray(item.content)) {
      for (const content of item.content) {
        if (!isRecord(content)) continue;
        if (typeof content.text === 'string') {
          parts.push(content.text);
        }
      }
    }
  }

  return parts.join('');
}

type ResponsesUsage = NonNullable<OpenAIResponsesMergedResponse['usage']>;

type OutputItemSnapshot = Record<string, unknown> & { type?: string; content?: unknown[]; summary?: unknown[]; arguments?: string };

export class OpenAIResponsesAccumulator implements StreamAccumulator<OpenAIResponsesMergedResponse> {
  private hasData = false;
  private hasCompleted = false;
  private outputTextDone = false;
  private reasoningTextDone = false;
  private readonly outputItems: Record<number, OutputItemSnapshot> = {};
  private readonly merged: OpenAIResponsesMergedResponse = {
    id: '',
    object: 'response',
    model: '',
    output_text: '',
    reasoning_text: '',
    tool_calls: [],
  };

  accept(chunk: SSEChunk): void {
    if (!isOpenAIResponsesEvent(chunk.data)) return;
    this.hasData = true;
    const event = chunk.data;

    this.mergeResponse(event);
    this.mergeEvent(event);
  }

  final(): OpenAIResponsesMergedResponse | null {
    if (!this.hasData) return null;
    if (!this.hasCompleted && Object.keys(this.outputItems).length > 0) {
      this.merged.output = this.buildOutputSnapshot();
      const outputText = extractResponseOutputText(this.merged.output);
      if (outputText) this.merged.output_text = outputText;
    }
    if (!this.merged.reasoning_text) delete this.merged.reasoning_text;
    if (!this.merged.tool_calls?.length) delete this.merged.tool_calls;
    return this.merged;
  }

  private mergeResponse(event: OpenAIResponsesEvent): void {
    const response = event.response;
    if (!response) return;

    if (response.id) this.merged.id = response.id;
    if (response.object) this.merged.object = response.object;
    if (response.created !== undefined) this.merged.created = response.created;
    if (response.created_at !== undefined) this.merged.created_at = response.created_at;
    if (response.model) this.merged.model = response.model;
    if (response.status) this.merged.status = response.status;
    if (response.error !== undefined) this.merged.error = response.error;
    if (response.incomplete_details !== undefined) this.merged.incomplete_details = response.incomplete_details;
    if (response.usage) {
      this.merged.usage = mergeDefinedFields(this.merged.usage, response.usage) as ResponsesUsage | undefined;
    }
    if (response.output) {
      this.merged.output = response.output;
      this.syncToolCallsFromOutput(response.output);
      const outputText = extractResponseOutputText(response.output);
      if (outputText) this.merged.output_text = outputText;
    }
    if (response.output_text) this.merged.output_text = response.output_text;
    if (event.type === 'response.completed') this.hasCompleted = true;
  }

  private mergeEvent(event: OpenAIResponsesEvent): void {
    if (this.hasCompleted && event.type !== 'response.completed') return;

    switch (event.type) {
      case 'response.output_text.delta':
        if (!this.outputTextDone) {
          this.merged.output_text = (this.merged.output_text || '') + (event.delta || '');
          this.appendTextPart(event, event.delta || '');
        }
        break;
      case 'response.output_text.done':
        if (event.text !== undefined) this.merged.output_text = event.text;
        this.replaceTextPart(event, event.text || '');
        this.outputTextDone = true;
        break;
      case 'response.reasoning_text.delta':
      case 'response.reasoning.delta':
        if (!this.reasoningTextDone) {
          this.merged.reasoning_text = (this.merged.reasoning_text || '') + (event.delta || '');
        }
        break;
      case 'response.reasoning_text.done':
        if (event.text !== undefined) this.merged.reasoning_text = event.text;
        this.reasoningTextDone = true;
        break;
      case 'response.reasoning_summary_text.delta':
        this.mergeReasoningSummaryText(event, event.delta || '', false);
        break;
      case 'response.reasoning_summary_text.done':
        this.mergeReasoningSummaryText(event, event.text || '', true);
        break;
      case 'response.content_part.added':
      case 'response.content_part.done':
        this.mergeContentPart(event);
        break;
      case 'response.function_call_arguments.delta':
        this.ensureToolCall(event.output_index ?? 0).function.arguments += event.delta || '';
        this.ensureOutputItem(event.output_index ?? 0, 'function_call').arguments = this.ensureToolCall(event.output_index ?? 0).function.arguments;
        break;
      case 'response.function_call_arguments.done': {
        const toolCall = this.ensureToolCall(event.output_index ?? 0);
        if (event.arguments) toolCall.function.arguments = event.arguments;
        this.ensureOutputItem(event.output_index ?? 0, 'function_call').arguments = toolCall.function.arguments;
        break;
      }
      case 'response.output_item.added':
      case 'response.output_item.done':
        this.mergeOutputItem(event);
        break;
      case 'response.failed':
      case 'response.error':
        this.merged.error = event.error ?? this.merged.error ?? null;
        break;
      case 'response.incomplete':
        this.merged.incomplete_details = event.incomplete_details ?? this.merged.incomplete_details ?? null;
        break;
    }
  }

  private mergeOutputItem(event: OpenAIResponsesEvent): void {
    if (!event.item?.type) return;

    const index = event.output_index ?? this.nextOutputIndex();
    const item = this.ensureOutputItem(index, event.item.type);
    Object.assign(item, mergeDefinedFields(item, event.item));

    if (event.item.type === 'function_call') {
      const toolCall = this.ensureToolCall(index);
      if (event.item.id || event.item.call_id) toolCall.id = event.item.id || event.item.call_id;
      toolCall.type = event.item.type;
      if (event.item.name) toolCall.function.name = event.item.name;
      if (event.item.arguments) toolCall.function.arguments = event.item.arguments;
    }
  }

  private mergeContentPart(event: OpenAIResponsesEvent): void {
    if (!event.part) return;

    const item = this.ensureOutputItem(event.output_index ?? 0, 'message');
    item.content ??= [];
    const content = item.content as unknown[];
    const index = event.content_index ?? content.length;
    content[index] = mergeDefinedFields(isRecord(content[index]) ? content[index] : undefined, event.part) ?? event.part;
  }

  private appendTextPart(event: OpenAIResponsesEvent, delta: string): void {
    const item = this.ensureOutputItem(event.output_index ?? 0, 'message');
    item.content ??= [];
    const content = item.content as unknown[];
    const index = event.content_index ?? 0;
    const part = isRecord(content[index]) ? content[index] : { type: 'output_text', text: '' };
    part.type ??= 'output_text';
    part.text = String(part.text ?? '') + delta;
    content[index] = part;
  }

  private replaceTextPart(event: OpenAIResponsesEvent, text: string): void {
    const item = this.ensureOutputItem(event.output_index ?? 0, 'message');
    item.content ??= [];
    const content = item.content as unknown[];
    const index = event.content_index ?? 0;
    const part = isRecord(content[index]) ? content[index] : { type: 'output_text' };
    part.type ??= 'output_text';
    part.text = text;
    content[index] = part;
  }

  private mergeReasoningSummaryText(event: OpenAIResponsesEvent, text: string, done: boolean): void {
    const item = this.ensureOutputItem(event.output_index ?? 0, 'reasoning');
    item.summary ??= [{ type: 'summary_text', text: '' }];
    const summary = item.summary as Record<string, unknown>[];
    const part = summary[0] ?? { type: 'summary_text', text: '' };
    part.text = done ? text : String(part.text ?? '') + text;
    summary[0] = part;
    item.summary = summary;
    this.merged.reasoning_text = String(part.text ?? '');
  }

  private ensureOutputItem(index: number, type: string): OutputItemSnapshot {
    if (!this.outputItems[index]) {
      this.outputItems[index] = { type };
    }
    this.outputItems[index].type ??= type;
    return this.outputItems[index];
  }

  private buildOutputSnapshot(): unknown[] {
    return Object.keys(this.outputItems)
      .map(Number)
      .sort((a, b) => a - b)
      .map(index => this.outputItems[index]);
  }

  private nextOutputIndex(): number {
    const indexes = Object.keys(this.outputItems).map(Number);
    return indexes.length === 0 ? 0 : Math.max(...indexes) + 1;
  }

  private syncToolCallsFromOutput(output: unknown[]): void {
    for (let index = 0; index < output.length; index += 1) {
      const item = output[index];
      if (!isRecord(item) || item.type !== 'function_call') continue;

      const toolCall = this.ensureToolCall(index);
      if (typeof item.id === 'string' || typeof item.call_id === 'string') {
        toolCall.id = (item.id || item.call_id) as string;
      }
      toolCall.type = 'function_call';
      if (typeof item.name === 'string') toolCall.function.name = item.name;
      if (typeof item.arguments === 'string') toolCall.function.arguments = item.arguments;
    }
  }

  private ensureToolCall(index: number): MergedToolCall {
    this.merged.tool_calls ??= [];
    if (!this.merged.tool_calls[index]) {
      this.merged.tool_calls[index] = { index, function: { arguments: '' } };
    }
    return this.merged.tool_calls[index];
  }
}
