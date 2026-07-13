import assert from 'node:assert/strict';
import { ENDPOINT_DEFINITIONS, assertEndpointProvider, resolveEndpoint } from '../src/endpoints';
import { extractToolCalls, extractToolOutputs } from '../src/tool-calls';

assert.equal(ENDPOINT_DEFINITIONS.length, 3);
for (const definition of ENDPOINT_DEFINITIONS) {
  const path = {
    'openai-chat': '/v1/chat/completions',
    'openai-responses': '/v1/responses',
    'anthropic-messages': '/v1/messages',
  }[definition.endpoint];
  assert.equal(resolveEndpoint(path).endpoint, definition.endpoint);
  assert.equal(ENDPOINT_DEFINITIONS.filter(candidate => candidate.routePattern.test(path)).length, 1);
}
assert.throws(() => resolveEndpoint('/v1/unknown'), /必须且只能匹配一个/);
assert.throws(() => assertEndpointProvider('/v1/responses', 'anthropic'), /不一致/);

const responseCalls = extractToolCalls({
  id: 'resp_1', object: 'response', model: 'gpt', output: [
    { type: 'function_call', id: 'item_function', call_id: 'call_function', name: 'lookup', arguments: '{"q":1}' },
    { type: 'custom_tool_call', id: 'item_custom', call_id: 'call_custom', name: 'shell', input: 'echo ok' },
    { type: 'tool_search_call', id: 'item_search', call_id: 'call_search', arguments: { query: 'tool' } },
    { type: 'function_call', id: 'fallback_item', name: 'fallback', arguments: '{}' },
  ],
}, 'openai-responses');
assert.deepEqual(responseCalls.map(call => [call.callId, call.callIdSource, call.itemId, call.kind]), [
  ['call_function', 'call_id', 'item_function', 'function'],
  ['call_custom', 'call_id', 'item_custom', 'custom'],
  ['call_search', 'call_id', 'item_search', 'tool_search'],
  ['fallback_item', 'id', 'fallback_item', 'function'],
]);

const responseOutputs = extractToolOutputs({ input: [
  { type: 'function_call_output', call_id: 'call_function', output: { ok: true } },
  { type: 'custom_tool_call_output', call_id: 'call_custom', output: 'done' },
] }, 'openai-responses');
assert.deepEqual(responseOutputs, [
  { callId: 'call_function', result: '{"ok":true}' },
  { callId: 'call_custom', result: 'done' },
]);

const chatCalls = extractToolCalls({
  id: 'chat', object: 'chat.completion', created: 1, model: 'gpt', choices: [
    { message: { tool_calls: [{ id: 'chat_call', function: { name: 'chatTool', arguments: '{}' } }] } },
  ],
}, 'openai-chat');
assert.equal(chatCalls[0].callId, 'chat_call');

const anthropicCalls = extractToolCalls({
  id: 'msg', model: 'claude', role: 'assistant', stop_reason: null, stop_sequence: null,
  content: [{ type: 'tool_use', index: 0, id: 'toolu_1', name: 'anthropicTool', input: { a: 1 } }],
}, 'anthropic-messages');
assert.equal(anthropicCalls[0].callId, 'toolu_1');

console.log('endpoint and tool tests passed');
