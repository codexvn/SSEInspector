import assert from 'node:assert/strict'
import { buildResponseCards } from '../src/response-flow'
import { findLatestUserMessage } from '../src/protocol-content'
import { assertApiRecord } from '../src/api'

assert.throws(
  () => assertApiRecord({ apiType: 'openai', path: '/v1/responses' }, '测试记录'),
  /缺少合法 apiEndpoint/,
)
assert.throws(
  () => assertApiRecord({ apiEndpoint: 'openai-responses', apiType: 'anthropic', path: '/v1/responses' }, '测试记录'),
  /不一致/,
)

const responsesCards = buildResponseCards({
  output_text: '不应重复显示',
  reasoning_text: '不应重复显示',
  output: [
    { type: 'message', content: [
      { type: 'output_text', text: '第一段' },
      { type: 'output_text', text: '第二段' },
      { type: 'refusal', refusal: '拒绝内容' },
    ] },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: '推理摘要' }] },
    { type: 'custom_tool_call', id: 'item_1', call_id: 'call_1', name: 'shell', input: 'echo ok' },
    { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque' },
  ],
}, 'openai-responses')

assert.deepEqual(responsesCards.map(card => card.type), [
  'assistant_text',
  'assistant_text',
  'assistant_refusal',
  'assistant_thinking',
  'tool_call',
  'raw_item',
])
assert.equal(responsesCards.filter(card => card.type === 'assistant_text').length, 2)
const toolCard = responsesCards.find(card => card.type === 'tool_call')
assert.deepEqual(toolCard, {
  id: 'responses-tool-2',
  type: 'tool_call',
  callId: 'call_1',
  name: 'shell',
  arguments: 'echo ok',
})

const fallbackCards = buildResponseCards({ output: [], output_text: 'fallback text', reasoning_text: 'fallback reasoning' }, 'openai-responses')
assert.deepEqual(fallbackCards.map(card => card.type), ['assistant_thinking', 'assistant_text'])

const rawCards = buildResponseCards({ output: [] }, 'openai-responses')
assert.equal(rawCards[0].type, 'raw_item')

const latestUser = findLatestUserMessage({
  input: [
    { type: 'message', role: 'user', content: [
      { type: 'input_text', text: '第一块' },
      { type: 'input_image', image_url: 'https://example.com/image.png' },
      { type: 'input_text', text: '第二块' },
    ] },
  ],
}, 'openai-responses')
assert.equal(latestUser, '第一块\n第二块')

console.log('response flow tests passed')
