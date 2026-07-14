import assert from 'node:assert/strict'
import { analyzeRequestContext, utf8ByteLength } from '../src/context-composition'

const raw = JSON.stringify({
  model: 'gpt-test',
  stream: true,
  instructions: '系统说明',
  tools: [{ type: 'function', name: 'search', parameters: { type: 'object' } }],
  input: [
    { role: 'user', content: [{ type: 'input_text', text: '第一段' }, { type: 'input_image', image_url: 'https://example.com/a.png' }, { type: 'input_text', text: '第二段' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: '历史回答' }] },
    { type: 'function_call_output', call_id: 'call_1', output: '工具结果' },
  ],
})

const analysis = analyzeRequestContext(raw, 'openai-responses')
const byKind = Object.fromEntries(analysis.parts.map(part => [part.kind, part]))

assert.equal(analysis.model, 'gpt-test')
assert.equal(analysis.latestUserMessage, '第一段\n第二段')
assert.equal(analysis.summary, 'model: gpt-test  stream: true  tools: 1')
assert.ok(byKind.instructions.bytes > 0)
assert.ok(byKind.user.bytes > 0)
assert.ok(byKind.assistant.bytes > 0)
assert.ok(byKind.tool_definitions.bytes > 0)
assert.ok(byKind.tool_interactions.bytes > 0)
assert.ok(byKind.attachments.bytes > 0)
assert.ok(byKind.other.bytes >= 0)
assert.equal(analysis.parts.reduce((total, part) => total + part.ratio, 0), 100)
assert.equal(utf8ByteLength('中🙂'), 7)

const anthropic = analyzeRequestContext(JSON.stringify({
  model: 'claude-test',
  system: '规则',
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }, { type: 'tool_result', tool_use_id: 't1', content: '结果' }] }],
}), 'anthropic-messages')
assert.equal(anthropic.latestUserMessage, '你好')
assert.ok(anthropic.parts.find(part => part.kind === 'tool_interactions')!.bytes > 0)

const chat = analyzeRequestContext(JSON.stringify({
  model: 'gpt-test',
  messages: [
    { role: 'user', content: '问题' },
    { role: 'tool', tool_call_id: 'call_1', content: '工具结果' },
    { role: 'function', name: 'legacy_search', content: '旧版工具结果' },
  ],
}), 'openai-chat')
const chatByKind = Object.fromEntries(chat.parts.map(part => [part.kind, part]))
assert.equal(chat.latestUserMessage, '问题')
assert.equal(chatByKind.user.bytes, utf8ByteLength(JSON.stringify('问题')))
assert.ok(chatByKind.tool_interactions.bytes >= utf8ByteLength(JSON.stringify('工具结果')))

assert.throws(() => analyzeRequestContext('{bad json', 'openai-chat'))

console.log('context composition tests passed')
