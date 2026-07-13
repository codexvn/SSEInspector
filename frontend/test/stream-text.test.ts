import assert from 'node:assert/strict'
import { IncrementalSseTextExtractor } from '../src/stream-text'

const responses = new IncrementalSseTextExtractor('openai-responses')
const first = 'data: {"type":"response.output_text.delta","delta":"你"}\n'
assert.equal(responses.accept(first), '你')
assert.equal(responses.accept(first + 'data: {"type":"response.output_text.delta","delta":"好"}\n'), '你好')

const chat = new IncrementalSseTextExtractor('openai-chat')
assert.equal(chat.accept('data: {"choices":[{"delta":{"content":"A"}}]}\n'), 'A')
assert.equal(chat.accept('data: {"choices":[{"delta":{"content":"B"}}]}\n'), 'B')

const anthropic = new IncrementalSseTextExtractor('anthropic-messages')
assert.equal(
  anthropic.accept('data: {"type":"content_block_delta","delta":{"thinking":"思","text":"考"}}\n'),
  '考思',
)

console.log('stream-text tests passed')
