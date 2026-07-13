import { MergedToolCall, OpenAIResponsesMergedResponse, SSEChunk } from '../types';
import { isRecord, mergeDefinedFields, StreamAccumulator } from './types';

export interface OpenAIResponsesEvent extends Record<string, unknown> {
  type: string;
  response?: Record<string, unknown>;
  item?: Record<string, unknown>;
  part?: Record<string, unknown>;
  output_index?: number;
  content_index?: number;
  summary_index?: number;
  annotation_index?: number;
  delta?: string;
  text?: string;
  refusal?: string;
  arguments?: string;
  input?: string;
  code?: string;
  annotation?: unknown;
  error?: unknown;
  incomplete_details?: unknown;
}

type OutputItemSnapshot = Record<string, unknown> & {
  type?: string;
  content?: unknown[];
  summary?: unknown[];
};

interface ResponsesState {
  envelope: Record<string, unknown>;
  outputItems: Map<number, OutputItemSnapshot>;
  terminal: boolean;
}

type ResponsesEventCategory = 'lifecycle' | 'output_mutation' | 'auxiliary';

const LIFECYCLE_EVENTS = new Set([
  'response.created',
  'response.queued',
  'response.in_progress',
  'response.completed',
  'response.failed',
  'response.incomplete',
  'response.error',
]);

const TERMINAL_EVENTS = new Set(['response.completed', 'response.failed', 'response.incomplete', 'response.error']);
const AUXILIARY_EVENTS = new Set(['response.metadata']);

export function isOpenAIResponsesEvent(data: unknown): data is OpenAIResponsesEvent {
  return isRecord(data)
    && typeof data.type === 'string'
    && (data.type.startsWith('response.') || data.type === 'error');
}

export class OpenAIResponsesAccumulator implements StreamAccumulator<OpenAIResponsesMergedResponse> {
  private hasData = false;
  private outputDeclared = false;
  private readonly completedParts = new Set<string>();
  private readonly completedFields = new Set<string>();
  private readonly state: ResponsesState = {
    envelope: {},
    outputItems: new Map(),
    terminal: false,
  };

  accept(chunk: SSEChunk): void {
    if (!isOpenAIResponsesEvent(chunk.data)) return;
    const event = chunk.data;
    const category = categorizeEvent(event.type);
    if (category === 'auxiliary') return;

    this.hasData = true;
    if (event.type === 'error') {
      this.mergeErrorOnlyEvent(event);
      return;
    }
    if (category === 'lifecycle') {
      this.mergeLifecycle(event);
      return;
    }
    this.mergeOutputMutation(event);
  }

  final(): OpenAIResponsesMergedResponse | null {
    if (!this.hasData) return null;
    const result = { ...this.state.envelope } as OpenAIResponsesMergedResponse;
    const output = this.buildOutputSnapshot();
    if (this.outputDeclared || output.length > 0) result.output = output;

    const derivedOutputText = extractOutputText(output);
    if (derivedOutputText) result.output_text = derivedOutputText;
    const derivedReasoningText = extractReasoningText(output);
    if (derivedReasoningText) result.reasoning_text = derivedReasoningText;
    const toolCalls = buildToolCallConvenience(output);
    if (toolCalls.length > 0) result.tool_calls = toolCalls;

    return result;
  }

  private mergeLifecycle(event: OpenAIResponsesEvent): void {
    if (isRecord(event.response)) {
      const response = event.response;
      for (const [key, value] of Object.entries(response)) {
        if (value === undefined || key === 'output') continue;
        if (key === 'usage' && isRecord(value)) {
          this.state.envelope.usage = mergeDefinedFields(
            isRecord(this.state.envelope.usage) ? this.state.envelope.usage : undefined,
            value,
          );
        } else {
          this.state.envelope[key] = value;
        }
      }

      if (Array.isArray(response.output)) {
        this.outputDeclared = true;
        if (TERMINAL_EVENTS.has(event.type)) this.state.outputItems.clear();
        this.syncOutput(response.output);
      }
    }

    if ((event.type === 'response.failed' || event.type === 'response.error') && event.error !== undefined) {
      this.state.envelope.error = event.error;
    }
    if (event.type === 'response.incomplete' && event.incomplete_details !== undefined) {
      this.state.envelope.incomplete_details = event.incomplete_details;
    }
    if (TERMINAL_EVENTS.has(event.type)) this.state.terminal = true;
  }

  private mergeOutputMutation(event: OpenAIResponsesEvent): void {
    switch (event.type) {
      case 'response.output_item.added':
        this.mergeOutputItem(event, false);
        break;
      case 'response.output_item.done':
        this.mergeOutputItem(event, true);
        break;
      case 'response.content_part.added':
        this.mergeContentPart(event, false);
        break;
      case 'response.content_part.done':
        this.mergeContentPart(event, true);
        break;
      case 'response.output_text.delta':
        this.mergeContentText(event, 'output_text', 'text', event.delta ?? '', false);
        break;
      case 'response.output_text.done':
        this.mergeContentText(event, 'output_text', 'text', event.text ?? '', true);
        break;
      case 'response.output_text.annotation.added':
        this.mergeAnnotation(event);
        break;
      case 'response.refusal.delta':
        this.mergeContentText(event, 'refusal', 'refusal', event.delta ?? '', false);
        break;
      case 'response.refusal.done':
        this.mergeContentText(event, 'refusal', 'refusal', event.refusal ?? '', true);
        break;
      case 'response.reasoning_text.delta':
      case 'response.reasoning.delta':
        this.mergeContentText(event, 'reasoning_text', 'text', event.delta ?? '', false, 'reasoning');
        break;
      case 'response.reasoning_text.done':
        this.mergeContentText(event, 'reasoning_text', 'text', event.text ?? '', true, 'reasoning');
        break;
      case 'response.reasoning_summary_part.added':
        this.mergeReasoningSummaryPart(event, false);
        break;
      case 'response.reasoning_summary_part.done':
        this.mergeReasoningSummaryPart(event, true);
        break;
      case 'response.reasoning_summary_text.delta':
        this.mergeReasoningSummaryText(event, event.delta ?? '', false);
        break;
      case 'response.reasoning_summary_text.done':
        this.mergeReasoningSummaryText(event, event.text ?? '', true);
        break;
      case 'response.function_call_arguments.delta':
        this.mergeItemField(event, 'function_call', 'arguments', event.delta ?? '', false);
        break;
      case 'response.function_call_arguments.done':
        this.mergeItemField(event, 'function_call', 'arguments', event.arguments ?? '', true);
        break;
      case 'response.custom_tool_call_input.delta':
        this.mergeItemField(event, 'custom_tool_call', 'input', event.delta ?? '', false);
        break;
      case 'response.custom_tool_call_input.done':
        this.mergeItemField(event, 'custom_tool_call', 'input', event.input ?? '', true);
        break;
      case 'response.mcp_call_arguments.delta':
        this.mergeItemField(event, 'mcp_call', 'arguments', event.delta ?? '', false);
        break;
      case 'response.mcp_call_arguments.done':
        this.mergeItemField(event, 'mcp_call', 'arguments', event.arguments ?? '', true);
        break;
      case 'response.code_interpreter_call_code.delta':
        this.mergeItemField(event, 'code_interpreter_call', 'code', event.delta ?? '', false);
        break;
      case 'response.code_interpreter_call_code.done':
        this.mergeItemField(event, 'code_interpreter_call', 'code', event.code ?? '', true);
        break;
      case 'response.web_search_call.in_progress':
      case 'response.web_search_call.searching':
      case 'response.web_search_call.completed':
      case 'response.file_search_call.in_progress':
      case 'response.file_search_call.searching':
      case 'response.file_search_call.completed':
      case 'response.code_interpreter_call.in_progress':
      case 'response.code_interpreter_call.interpreting':
      case 'response.code_interpreter_call.completed':
      case 'response.tool_search_call.in_progress':
      case 'response.tool_search_call.searching':
      case 'response.tool_search_call.completed':
        this.mergeItemStatus(event);
        break;
    }
  }

  private mergeOutputItem(event: OpenAIResponsesEvent, done: boolean): void {
    const index = this.requireIndex(event, 'output_index');
    if (index === undefined || !isRecord(event.item)) return;
    this.outputDeclared = true;
    if (done) {
      this.state.outputItems.set(index, { ...event.item });
      return;
    }
    const current = this.state.outputItems.get(index);
    this.state.outputItems.set(index, mergeDefinedFields(current, event.item) as OutputItemSnapshot);
  }

  private mergeContentPart(event: OpenAIResponsesEvent, done: boolean): void {
    const indexes = this.requireContentIndexes(event);
    if (!indexes || !isRecord(event.part)) return;
    const item = this.ensureOutputItem(indexes.outputIndex, 'message');
    const content = ensureArray(item, 'content');
    const existingPart = content[indexes.contentIndex];
    content[indexes.contentIndex] = done
      ? { ...event.part }
      : mergeDefinedFields(isRecord(existingPart) ? existingPart : undefined, event.part);
    if (done) this.completedParts.add(partKey(indexes.outputIndex, indexes.contentIndex));
  }

  private mergeContentText(
    event: OpenAIResponsesEvent,
    partType: string,
    field: string,
    value: string,
    done: boolean,
    itemType = 'message',
  ): void {
    const indexes = this.requireContentIndexes(event);
    if (!indexes) return;
    const key = partKey(indexes.outputIndex, indexes.contentIndex);
    if (!done && this.completedParts.has(key)) return;
    const item = this.ensureOutputItem(indexes.outputIndex, itemType);
    applyEventItemIdentity(item, event);
    const content = ensureArray(item, 'content');
    const existingPart = content[indexes.contentIndex];
    const part: Record<string, unknown> = isRecord(existingPart) ? existingPart : { type: partType };
    part.type ??= partType;
    part[field] = done ? value : String(part[field] ?? '') + value;
    content[indexes.contentIndex] = part;
    if (done) this.completedParts.add(key);
  }

  private mergeAnnotation(event: OpenAIResponsesEvent): void {
    const indexes = this.requireContentIndexes(event);
    const annotationIndex = this.requireIndex(event, 'annotation_index');
    if (!indexes || annotationIndex === undefined || event.annotation === undefined) return;
    const item = this.ensureOutputItem(indexes.outputIndex, 'message');
    applyEventItemIdentity(item, event);
    const content = ensureArray(item, 'content');
    const existingPart = content[indexes.contentIndex];
    const part: Record<string, unknown> = isRecord(existingPart)
      ? existingPart
      : { type: 'output_text', text: '' };
    const annotations = ensureArray(part, 'annotations');
    annotations[annotationIndex] = event.annotation;
    content[indexes.contentIndex] = part;
  }

  private mergeReasoningSummaryPart(event: OpenAIResponsesEvent, done: boolean): void {
    const outputIndex = this.requireIndex(event, 'output_index');
    const summaryIndex = this.requireIndex(event, 'summary_index');
    if (outputIndex === undefined || summaryIndex === undefined || !isRecord(event.part)) return;
    const item = this.ensureOutputItem(outputIndex, 'reasoning');
    applyEventItemIdentity(item, event);
    const summary = ensureArray(item, 'summary');
    summary[summaryIndex] = done
      ? { ...event.part }
      : mergeDefinedFields(isRecord(summary[summaryIndex]) ? summary[summaryIndex] : undefined, event.part);
    if (done) this.completedParts.add(summaryKey(outputIndex, summaryIndex));
  }

  private mergeReasoningSummaryText(event: OpenAIResponsesEvent, value: string, done: boolean): void {
    const outputIndex = this.requireIndex(event, 'output_index');
    const summaryIndex = this.requireIndex(event, 'summary_index');
    if (outputIndex === undefined || summaryIndex === undefined) return;
    const key = summaryKey(outputIndex, summaryIndex);
    if (!done && this.completedParts.has(key)) return;
    const item = this.ensureOutputItem(outputIndex, 'reasoning');
    applyEventItemIdentity(item, event);
    const summary = ensureArray(item, 'summary');
    const part = isRecord(summary[summaryIndex]) ? summary[summaryIndex] : { type: 'summary_text' };
    part.type ??= 'summary_text';
    part.text = done ? value : String(part.text ?? '') + value;
    summary[summaryIndex] = part;
    if (done) this.completedParts.add(key);
  }

  private mergeItemField(
    event: OpenAIResponsesEvent,
    itemType: string,
    field: string,
    value: string,
    done: boolean,
  ): void {
    const outputIndex = this.requireIndex(event, 'output_index');
    if (outputIndex === undefined) return;
    const key = `${outputIndex}:${field}`;
    if (!done && this.completedFields.has(key)) return;
    const item = this.ensureOutputItem(outputIndex, itemType);
    applyEventItemIdentity(item, event);
    if (typeof event.name === 'string') item.name = event.name;
    item[field] = done ? value : String(item[field] ?? '') + value;
    if (done) this.completedFields.add(key);
  }

  private mergeItemStatus(event: OpenAIResponsesEvent): void {
    const outputIndex = this.requireIndex(event, 'output_index');
    if (outputIndex === undefined) return;
    const [, itemType, status] = /^response\.(.+)\.(in_progress|searching|interpreting|completed)$/.exec(event.type) ?? [];
    if (!itemType || !status) return;
    const item = this.ensureOutputItem(outputIndex, itemType);
    applyEventItemIdentity(item, event);
    item.status = status;
  }

  private mergeErrorOnlyEvent(event: OpenAIResponsesEvent): void {
    if (event.error !== undefined) {
      this.state.envelope.error = event.error;
      return;
    }
    const error = Object.fromEntries(
      Object.entries(event).filter(([key, value]) => key !== 'type' && key !== 'sequence_number' && value !== undefined),
    );
    this.state.envelope.error = error;
  }

  private syncOutput(output: unknown[]): void {
    for (let index = 0; index < output.length; index++) {
      const item = output[index];
      if (isRecord(item)) this.state.outputItems.set(index, { ...item });
    }
  }

  private ensureOutputItem(index: number, type: string): OutputItemSnapshot {
    this.outputDeclared = true;
    const existing = this.state.outputItems.get(index);
    if (existing) {
      existing.type ??= type;
      return existing;
    }
    const item: OutputItemSnapshot = { type };
    this.state.outputItems.set(index, item);
    return item;
  }

  private requireContentIndexes(event: OpenAIResponsesEvent): { outputIndex: number; contentIndex: number } | undefined {
    const outputIndex = this.requireIndex(event, 'output_index');
    const contentIndex = this.requireIndex(event, 'content_index');
    return outputIndex === undefined || contentIndex === undefined ? undefined : { outputIndex, contentIndex };
  }

  private requireIndex(event: OpenAIResponsesEvent, field: 'output_index' | 'content_index' | 'summary_index' | 'annotation_index'): number | undefined {
    const value = event[field];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
    console.warn(`[OpenAIResponsesAccumulator] 忽略缺少有效 ${field} 的事件: type=${event.type}`);
    return undefined;
  }

  private buildOutputSnapshot(): unknown[] {
    return [...this.state.outputItems.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, item]) => item);
  }
}

function categorizeEvent(type: string): ResponsesEventCategory {
  if (LIFECYCLE_EVENTS.has(type)) return 'lifecycle';
  if (AUXILIARY_EVENTS.has(type)) return 'auxiliary';
  return 'output_mutation';
}

function ensureArray(target: Record<string, unknown>, field: string): unknown[] {
  if (!Array.isArray(target[field])) target[field] = [];
  return target[field] as unknown[];
}

function applyEventItemIdentity(item: Record<string, unknown>, event: OpenAIResponsesEvent): void {
  if (typeof event.item_id === 'string' && item.id === undefined) item.id = event.item_id;
}

function partKey(outputIndex: number, contentIndex: number): string {
  return `content:${outputIndex}:${contentIndex}`;
}

function summaryKey(outputIndex: number, summaryIndex: number): string {
  return `summary:${outputIndex}:${summaryIndex}`;
}

function extractOutputText(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('');
}

function extractReasoningText(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'reasoning') continue;
    for (const collection of [item.summary, item.content]) {
      if (!Array.isArray(collection)) continue;
      for (const part of collection) {
        if (isRecord(part) && typeof part.text === 'string') parts.push(part.text);
      }
    }
  }
  return parts.join('\n');
}

function buildToolCallConvenience(output: unknown[]): MergedToolCall[] {
  const toolCalls: MergedToolCall[] = [];
  for (let index = 0; index < output.length; index++) {
    const item = output[index];
    if (!isRecord(item) || (item.type !== 'function_call' && item.type !== 'custom_tool_call')) continue;
    toolCalls.push({
      index,
      id: stringField(item.call_id) ?? stringField(item.id),
      type: String(item.type),
      function: {
        name: stringField(item.name),
        arguments: stringField(item.arguments) ?? stringField(item.input) ?? '',
      },
    });
  }
  return toolCalls;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
