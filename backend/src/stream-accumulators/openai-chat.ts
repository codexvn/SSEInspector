import { MergedResponse, MergedToolCall, SSEChunk } from '../types';
import { isRecord, mergeDefinedFields, StreamAccumulator } from './types';

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
      refusal?: string;
      function_call?: { name?: string; arguments?: string };
      tool_calls?: {
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
      logprobs?: unknown;
      filter_results?: unknown;
      [key: string]: unknown;
    };
    finish_reason?: string | null;
    logprobs?: unknown;
    content_filter_results?: unknown;
    [key: string]: unknown;
  }[];
  usage?: Record<string, unknown>;
  prompt_filter_results?: unknown;
}

type MergedUsage = NonNullable<MergedResponse['usage']>;

export class OpenAIChatAccumulator implements StreamAccumulator<MergedResponse> {
  private hasData = false;
  private readonly merged: MergedResponse = { id: '', object: '', created: 0, model: '', choices: [] };

  accept(chunk: SSEChunk): void {
    if (!isRecord(chunk.data)) return;
    const delta = chunk.data as OpenAIDelta;
    this.hasData = true;

    if (delta.id) this.merged.id = delta.id;
    if (delta.object) this.merged.object = delta.object;
    if (delta.created) this.merged.created = delta.created;
    if (delta.model) this.merged.model = delta.model;
    if (delta.usage) {
      this.merged.usage = mergeDefinedFields(this.merged.usage, delta.usage) as MergedUsage | undefined;
    }
    if (delta.prompt_filter_results !== undefined) {
      this.merged.prompt_filter_results = delta.prompt_filter_results;
    }

    for (const choiceDelta of delta.choices ?? []) {
      const index = choiceDelta.index;
      if (!this.merged.choices[index]) {
        this.merged.choices[index] = { index, message: { role: '', content: '' }, finish_reason: null };
      }

      const choice = this.merged.choices[index];
      const d = choiceDelta.delta ?? {};

      if (choiceDelta.logprobs !== undefined) choice.logprobs = choiceDelta.logprobs;
      if (choiceDelta.content_filter_results !== undefined) {
        choice.content_filter_results = choiceDelta.content_filter_results;
      }

      if (d.role) choice.message.role = d.role;
      if (d.content != null) choice.message.content += d.content;
      if (d.reasoning_content != null) {
        choice.message.reasoning_content ??= '';
        choice.message.reasoning_content += d.reasoning_content;
      }
      if (d.refusal != null) {
        choice.message.refusal ??= '';
        choice.message.refusal += d.refusal;
      }
      if (d.function_call) {
        choice.message.function_call ??= { arguments: '' };
        if (d.function_call.name) choice.message.function_call.name = d.function_call.name;
        if (d.function_call.arguments != null) {
          choice.message.function_call.arguments += d.function_call.arguments;
        }
      }
      if (d.logprobs !== undefined) choice.message.logprobs = d.logprobs;
      if (d.filter_results !== undefined) choice.message.filter_results = d.filter_results;
      if (d.tool_calls) {
        choice.message.tool_calls ??= [];
        for (const toolCallDelta of d.tool_calls) {
          if (!choice.message.tool_calls[toolCallDelta.index]) {
            choice.message.tool_calls[toolCallDelta.index] = { index: toolCallDelta.index, function: { arguments: '' } };
          }

          const toolCall: MergedToolCall = choice.message.tool_calls[toolCallDelta.index];
          if (toolCallDelta.id) toolCall.id = toolCallDelta.id;
          if (toolCallDelta.type) toolCall.type = toolCallDelta.type;
          if (toolCallDelta.function?.name) toolCall.function.name = toolCallDelta.function.name;
          if (toolCallDelta.function?.arguments != null) {
            toolCall.function.arguments += toolCallDelta.function.arguments;
          }
        }
      }
      if (choiceDelta.finish_reason != null) choice.finish_reason = choiceDelta.finish_reason;
    }
  }

  final(): MergedResponse | null {
    return this.hasData ? this.merged : null;
  }
}
