import assert from 'node:assert/strict';
import { parseOutputTokens, parseUsageSummary, serializeApiUsage } from '../src/api-usage';

assert.equal(serializeApiUsage({ usage: null }), undefined);
assert.equal(serializeApiUsage({ usage: undefined }), undefined);
assert.equal(serializeApiUsage({ usage: [] }), undefined);
assert.equal(serializeApiUsage({ usage: { input_tokens: 3, output_tokens: 5 } }), '{"input_tokens":3,"output_tokens":5}');

assert.equal(parseOutputTokens('{"completion_tokens":7}'), 7);
assert.equal(parseOutputTokens('{"output_tokens":9}'), 9);
assert.equal(parseOutputTokens('{"output_tokens_details":{"reasoning_tokens":4}}'), undefined);

assert.deepEqual(parseUsageSummary(JSON.stringify({
  prompt_tokens: 100,
  completion_tokens: 20,
  prompt_tokens_details: { cached_tokens: 40 },
}), 'openai-chat'), { inputTokens: 100, outputTokens: 20, cacheRead: 40 });
assert.deepEqual(parseUsageSummary(JSON.stringify({
  input_tokens: 120,
  output_tokens: 30,
  input_tokens_details: { cached_tokens: 50 },
}), 'openai-responses'), { inputTokens: 120, outputTokens: 30, cacheRead: 50 });
assert.deepEqual(parseUsageSummary(JSON.stringify({
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: 20,
  cache_read_input_tokens: 70,
}), 'anthropic-messages'), { inputTokens: 100, outputTokens: 5, cacheRead: 70 });
assert.deepEqual(parseUsageSummary(undefined, 'openai-responses'), {});

console.log('api usage tests passed');
