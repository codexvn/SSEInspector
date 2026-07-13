import assert from 'node:assert/strict';
import { parseOutputTokens, serializeApiUsage } from '../src/api-usage';

assert.equal(serializeApiUsage({ usage: null }), undefined);
assert.equal(serializeApiUsage({ usage: undefined }), undefined);
assert.equal(serializeApiUsage({ usage: [] }), undefined);
assert.equal(serializeApiUsage({ usage: { input_tokens: 3, output_tokens: 5 } }), '{"input_tokens":3,"output_tokens":5}');

assert.equal(parseOutputTokens('{"completion_tokens":7}'), 7);
assert.equal(parseOutputTokens('{"output_tokens":9}'), 9);
assert.equal(parseOutputTokens('{"output_tokens_details":{"reasoning_tokens":4}}'), undefined);

console.log('api usage tests passed');
