import assert from 'node:assert/strict';
import { mergeChunks, parseSSE } from '../src/sse-merger';
import { AnthropicMergedResponse, MergedResponse, OpenAIResponsesMergedResponse } from '../src/types';

function dataLine(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function eventBlock(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function testAnthropicUsageMerge(): void {
  const raw = [
    eventBlock('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_1',
        model: 'glm-5.2',
        role: 'assistant',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
    eventBlock('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: {
        input_tokens: 2019,
        output_tokens: 88,
        cache_read_input_tokens: 59392,
        server_tool_use: { web_search_requests: 1 },
        service_tier: 'standard',
      },
    }),
  ].join('');

  const merged = mergeChunks(parseSSE(raw, 'anthropic'), 'anthropic') as AnthropicMergedResponse;

  assert.equal(merged.usage?.input_tokens, 2019);
  assert.equal(merged.usage?.output_tokens, 88);
  assert.equal(merged.usage?.cache_read_input_tokens, 59392);
  assert.deepEqual(merged.usage?.server_tool_use, { web_search_requests: 1 });
  assert.equal(merged.usage?.service_tier, 'standard');
}

function testAnthropicInputJsonDelta(): void {
  const raw = [
    eventBlock('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_2',
        model: 'claude',
        role: 'assistant',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    eventBlock('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} },
    }),
    eventBlock('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"query":"hel' },
    }),
    eventBlock('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: 'lo"}' },
    }),
  ].join('');

  const merged = mergeChunks(parseSSE(raw, 'anthropic'), 'anthropic') as AnthropicMergedResponse;

  assert.deepEqual(merged.content[0].input, { query: 'hello' });
  assert.equal((merged.content[0] as unknown as Record<string, unknown>)._input_raw, undefined);
}

function testAnthropicCitationsDelta(): void {
  const raw = [
    eventBlock('message_start', {
      type: 'message_start',
      message: { id: 'msg_3', model: 'claude', role: 'assistant', content: [], stop_reason: null, stop_sequence: null },
    }),
    eventBlock('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    eventBlock('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '引用文本' },
    }),
    eventBlock('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'citations_delta', citation: { type: 'url_citation', url: 'https://example.com' } },
    }),
  ].join('');

  const merged = mergeChunks(parseSSE(raw, 'anthropic'), 'anthropic') as AnthropicMergedResponse;

  assert.equal(merged.content[0].text, '引用文本');
  assert.deepEqual(merged.content[0].citations, [{ type: 'url_citation', url: 'https://example.com' }]);
}

function testAnthropicSignatureDelta(): void {
  const raw = [
    eventBlock('message_start', {
      type: 'message_start',
      message: { id: 'msg_4', model: 'claude', role: 'assistant', content: [], stop_reason: null, stop_sequence: null },
    }),
    eventBlock('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    }),
    eventBlock('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: '思考' },
    }),
    eventBlock('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig-1' },
    }),
  ].join('');

  const merged = mergeChunks(parseSSE(raw, 'anthropic'), 'anthropic') as AnthropicMergedResponse;

  assert.equal(merged.content[0].thinking, '思考');
  assert.equal(merged.content[0].signature, 'sig-1');
}

function testAnthropicRedactedThinking(): void {
  const raw = [
    eventBlock('message_start', {
      type: 'message_start',
      message: { id: 'msg_5', model: 'claude', role: 'assistant', content: [], stop_reason: null, stop_sequence: null },
    }),
    eventBlock('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'redacted_thinking', data: 'encrypted-data' },
    }),
  ].join('');

  const merged = mergeChunks(parseSSE(raw, 'anthropic'), 'anthropic') as AnthropicMergedResponse;

  assert.equal(merged.content[0].type, 'redacted_thinking');
  assert.equal(merged.content[0].data, 'encrypted-data');
}

function testAnthropicUnknownBlockPreserved(): void {
  const raw = [
    eventBlock('message_start', {
      type: 'message_start',
      message: { id: 'msg_6', model: 'claude', role: 'assistant', content: [], stop_reason: null, stop_sequence: null },
    }),
    eventBlock('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'custom_search_v2', custom: { query: 'x' } },
    }),
    eventBlock('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'custom_delta', value: 'part' },
    }),
  ].join('');

  const merged = mergeChunks(parseSSE(raw, 'anthropic'), 'anthropic') as AnthropicMergedResponse;
  const block = merged.content[0] as Record<string, unknown>;

  assert.equal(block.type, 'custom_search_v2');
  assert.deepEqual(block._raw, { type: 'custom_search_v2', custom: { query: 'x' } });
  assert.deepEqual(block._deltas, [{ type: 'custom_delta', value: 'part' }]);
}

function testOpenAIChatMerge(): void {
  const raw = [
    dataLine({ id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'gpt', choices: [{ index: 0, delta: { role: 'assistant' } }] }),
    dataLine({ choices: [{ index: 0, delta: { content: '你' } }] }),
    dataLine({ choices: [{ index: 0, delta: { content: '好' } }] }),
    dataLine({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'foo', arguments: '{"a"' } }] } }] }),
    dataLine({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: 'tool_calls' }] }),
    dataLine({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }),
    'data: [DONE]\n\n',
  ].join('');

  const merged = mergeChunks(parseSSE(raw, 'openai'), 'openai') as MergedResponse;

  assert.equal(merged.choices[0].message.content, '你好');
  assert.equal(merged.choices[0].finish_reason, 'tool_calls');
  assert.equal(merged.choices[0].message.tool_calls?.[0].function.arguments, '{"a":1}');
  assert.equal(merged.usage?.total_tokens, 7);
}

function testOpenAIChatLegacyFunctionCall(): void {
  const raw = [
    dataLine({ id: 'chatcmpl_legacy', object: 'chat.completion.chunk', created: 1, model: 'gpt', choices: [{ index: 0, delta: { role: 'assistant' } }] }),
    dataLine({ choices: [{ index: 0, delta: { function_call: { name: 'legacyTool', arguments: '{"a"' } } }] }),
    dataLine({ choices: [{ index: 0, delta: { function_call: { arguments: ':1}' } }, finish_reason: 'function_call' }] }),
  ].join('');

  const merged = mergeChunks(parseSSE(raw, 'openai'), 'openai') as MergedResponse;

  assert.equal(merged.choices[0].message.function_call?.name, 'legacyTool');
  assert.equal(merged.choices[0].message.function_call?.arguments, '{"a":1}');
  assert.equal(merged.choices[0].finish_reason, 'function_call');
}

function testOpenAIChatRefusal(): void {
  const raw = [
    dataLine({ id: 'chatcmpl_refusal', object: 'chat.completion.chunk', created: 1, model: 'gpt', choices: [{ index: 0, delta: { role: 'assistant' } }] }),
    dataLine({ choices: [{ index: 0, delta: { refusal: '不能' } }] }),
    dataLine({ choices: [{ index: 0, delta: { refusal: '回答' }, finish_reason: 'content_filter' }] }),
  ].join('');

  const merged = mergeChunks(parseSSE(raw, 'openai'), 'openai') as MergedResponse;

  assert.equal(merged.choices[0].message.refusal, '不能回答');
  assert.equal(merged.choices[0].finish_reason, 'content_filter');
}

function testOpenAIChatLogprobsAndFilterResults(): void {
  const logprobs = { content: [{ token: '你', logprob: -0.1 }] };
  const contentFilterResults = { hate: { filtered: false } };
  const promptFilterResults = [{ prompt_index: 0, content_filter_results: contentFilterResults }];
  const raw = [
    dataLine({ id: 'chatcmpl_logprobs', object: 'chat.completion.chunk', created: 1, model: 'gpt', prompt_filter_results: promptFilterResults, choices: [{ index: 0, delta: { role: 'assistant', content: '你' }, logprobs, content_filter_results: contentFilterResults }] }),
  ].join('');

  const merged = mergeChunks(parseSSE(raw, 'openai'), 'openai') as MergedResponse;

  assert.equal(merged.choices[0].message.content, '你');
  assert.deepEqual(merged.choices[0].logprobs, logprobs);
  assert.deepEqual(merged.choices[0].content_filter_results, contentFilterResults);
  assert.deepEqual(merged.prompt_filter_results, promptFilterResults);
}

function testOpenAIResponsesMerge(): void {
  const raw = [
    dataLine({ type: 'response.created', response: { id: 'resp_1', object: 'response', model: 'gpt' } }),
    dataLine({ type: 'response.output_text.delta', delta: 'hel' }),
    dataLine({ type: 'response.output_text.delta', delta: 'lo' }),
    dataLine({ type: 'response.output_text.done', text: 'hello' }),
    dataLine({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', name: 'lookup' } }),
    dataLine({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"q"' }),
    dataLine({ type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"q":"x"}' }),
    dataLine({ type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2, service_tier: 'standard' } } }),
  ].join('');

  const merged = mergeChunks(parseSSE(raw, 'openai'), 'openai') as OpenAIResponsesMergedResponse;

  assert.equal(merged.output_text, 'hello');
  assert.equal(merged.tool_calls?.[0].id, 'fc_1');
  assert.equal(merged.tool_calls?.[0].function.name, 'lookup');
  assert.equal(merged.tool_calls?.[0].function.arguments, '{"q":"x"}');
  assert.equal(merged.usage?.input_tokens, 5);
  assert.equal(merged.usage?.service_tier, 'standard');
}

function testOpenAIResponsesCompletedPriority(): void {
  const raw = [
    dataLine({ type: 'response.created', response: { id: 'resp_done', object: 'response', model: 'gpt', output: [] } }),
    dataLine({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '短' }),
    dataLine({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: '较长的完整文本' }),
    dataLine({ type: 'response.completed', response: { id: 'resp_done', object: 'response', model: 'gpt', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '最终权威文本' }] }, { type: 'function_call', id: 'fc_done', name: 'doneTool', arguments: '{"ok":true}' }], usage: { input_tokens: 10, output_tokens: 3 } } }),
  ].join('');

  const merged = mergeChunks(parseSSE(raw, 'openai'), 'openai') as OpenAIResponsesMergedResponse;

  assert.equal(merged.output_text, '最终权威文本');
  assert.equal(merged.status, 'completed');
  assert.equal(merged.tool_calls?.[1].function.arguments, '{"ok":true}');
  assert.equal(merged.usage?.input_tokens, 10);
}

function testOpenAIResponsesContentPart(): void {
  const raw = [
    dataLine({ type: 'response.created', response: { id: 'resp_part', object: 'response', model: 'gpt' } }),
    dataLine({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_out', role: 'assistant', content: [] } }),
    dataLine({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }),
    dataLine({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'abc' }),
    dataLine({ type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'abc', annotations: [{ type: 'url_citation', url: 'https://example.com' }] } }),
  ].join('');

  const merged = mergeChunks(parseSSE(raw, 'openai'), 'openai') as OpenAIResponsesMergedResponse;
  const output = merged.output?.[0] as { content?: Array<Record<string, unknown>> } | undefined;

  assert.equal(merged.output_text, 'abc');
  assert.equal(output?.content?.[0].text, 'abc');
  assert.deepEqual(output?.content?.[0].annotations, [{ type: 'url_citation', url: 'https://example.com' }]);
}

function testOpenAIResponsesReasoningSummaryText(): void {
  const raw = [
    dataLine({ type: 'response.created', response: { id: 'resp_reasoning', object: 'response', model: 'gpt' } }),
    dataLine({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } }),
    dataLine({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '推理' }),
    dataLine({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '过程' }),
    dataLine({ type: 'response.reasoning_summary_text.done', output_index: 0, text: '推理过程' }),
  ].join('');

  const merged = mergeChunks(parseSSE(raw, 'openai'), 'openai') as OpenAIResponsesMergedResponse;
  const output = merged.output?.[0] as { summary?: Array<Record<string, unknown>> } | undefined;

  assert.equal(merged.reasoning_text, '推理过程');
  assert.equal(output?.summary?.[0].text, '推理过程');
}

function testOpenAIResponsesWebSearchCallItem(): void {
  const raw = [
    dataLine({ type: 'response.created', response: { id: 'resp_search', object: 'response', model: 'gpt' } }),
    dataLine({ type: 'response.output_item.added', output_index: 0, item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress' } }),
    dataLine({ type: 'response.output_item.done', output_index: 0, item: { type: 'web_search_call', id: 'ws_1', status: 'completed' } }),
  ].join('');

  const merged = mergeChunks(parseSSE(raw, 'openai'), 'openai') as OpenAIResponsesMergedResponse;
  const output = merged.output?.[0] as Record<string, unknown> | undefined;

  assert.equal(output?.type, 'web_search_call');
  assert.equal(output?.id, 'ws_1');
  assert.equal(output?.status, 'completed');
}

function testOpenAIResponsesUnknownItemTypePreserved(): void {
  const raw = [
    dataLine({ type: 'response.created', response: { id: 'resp_custom', object: 'response', model: 'gpt' } }),
    dataLine({ type: 'response.output_item.added', output_index: 0, item: { type: 'custom_tool_v3', id: 'custom_1', payload: { a: 1 } } }),
  ].join('');

  const merged = mergeChunks(parseSSE(raw, 'openai'), 'openai') as OpenAIResponsesMergedResponse;
  const output = merged.output?.[0] as Record<string, unknown> | undefined;

  assert.equal(output?.type, 'custom_tool_v3');
  assert.deepEqual(output?.payload, { a: 1 });
}

function testOpenAIResponsesErrorAndIncomplete(): void {
  const failed = mergeChunks(parseSSE([
    dataLine({ type: 'response.created', response: { id: 'resp_failed', object: 'response', model: 'gpt', status: 'in_progress' } }),
    dataLine({ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: '失败' } }, error: { code: 'server_error', message: '失败' } }),
  ].join(''), 'openai'), 'openai') as OpenAIResponsesMergedResponse;
  const incomplete = mergeChunks(parseSSE([
    dataLine({ type: 'response.created', response: { id: 'resp_incomplete', object: 'response', model: 'gpt', status: 'in_progress' } }),
    dataLine({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, incomplete_details: { reason: 'max_output_tokens' } }),
  ].join(''), 'openai'), 'openai') as OpenAIResponsesMergedResponse;

  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.error, { code: 'server_error', message: '失败' });
  assert.equal(incomplete.status, 'incomplete');
  assert.deepEqual(incomplete.incomplete_details, { reason: 'max_output_tokens' });
}

function testEmptyAndPingStreams(): void {
  assert.equal(mergeChunks(parseSSE('', 'openai'), 'openai'), null);
  assert.equal(mergeChunks(parseSSE('data: [DONE]\n\n', 'openai'), 'openai'), null);
  assert.equal(mergeChunks(parseSSE(eventBlock('ping', { type: 'ping' }), 'anthropic'), 'anthropic'), null);
}

function testAnthropicMessageStartOnly(): void {
  const raw = eventBlock('message_start', {
    type: 'message_start',
    message: { id: 'msg_only', model: 'claude', role: 'assistant', content: [], stop_reason: null, stop_sequence: null },
  });

  const merged = mergeChunks(parseSSE(raw, 'anthropic'), 'anthropic') as AnthropicMergedResponse;

  assert.equal(merged.id, 'msg_only');
  assert.deepEqual(merged.content, []);
}

function testOpenAIResponsesDonePriorityOverLaterDelta(): void {
  const raw = [
    dataLine({ type: 'response.created', response: { id: 'resp_order', object: 'response', model: 'gpt' } }),
    dataLine({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: '完成文本' }),
    dataLine({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '不应追加' }),
  ].join('');

  const merged = mergeChunks(parseSSE(raw, 'openai'), 'openai') as OpenAIResponsesMergedResponse;

  assert.equal(merged.output_text, '完成文本');
}

function testSSEParserEventAndDone(): void {
  const raw = [
    eventBlock('message_delta', { type: 'message_delta', usage: { output_tokens: 1 } }),
    'data: [DONE]\n\n',
  ].join('');

  const chunks = parseSSE(raw, 'anthropic');

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].event, 'message_delta');
  assert.deepEqual(chunks[0].data, { type: 'message_delta', usage: { output_tokens: 1 } });
}

testAnthropicUsageMerge();
testAnthropicInputJsonDelta();
testAnthropicCitationsDelta();
testAnthropicSignatureDelta();
testAnthropicRedactedThinking();
testAnthropicUnknownBlockPreserved();
testOpenAIChatMerge();
testOpenAIChatLegacyFunctionCall();
testOpenAIChatRefusal();
testOpenAIChatLogprobsAndFilterResults();
testOpenAIResponsesMerge();
testOpenAIResponsesCompletedPriority();
testOpenAIResponsesContentPart();
testOpenAIResponsesReasoningSummaryText();
testOpenAIResponsesWebSearchCallItem();
testOpenAIResponsesUnknownItemTypePreserved();
testOpenAIResponsesErrorAndIncomplete();
testEmptyAndPingStreams();
testAnthropicMessageStartOnly();
testOpenAIResponsesDonePriorityOverLaterDelta();
testSSEParserEventAndDone();

console.log('sse-merger tests passed');
