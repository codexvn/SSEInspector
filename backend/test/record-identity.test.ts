import assert from 'node:assert/strict'
import { ApiType, ApiEndpoint } from '../src/types'
import { resolveRecordIdentity } from '../src/record-identity'

function testPassthroughIdentity(): void {
  const id = resolveRecordIdentity({
    path: '/v1/models',
    apiType: ApiType.Passthrough,
    apiEndpoint: ApiEndpoint.Passthrough,
  })
  assert.deepEqual(id, {
    kind: 'passthrough',
    provider: ApiType.Passthrough,
    endpoint: ApiEndpoint.Passthrough,
  })
}

function testPassthroughRejectsMixed(): void {
  assert.throws(
    () => resolveRecordIdentity({
      path: '/v1/models',
      apiType: ApiType.Passthrough,
      apiEndpoint: ApiEndpoint.OpenAIChat,
    }),
    /passthrough/,
  )
  assert.throws(
    () => resolveRecordIdentity({
      path: '/v1/chat/completions',
      apiType: ApiType.OpenAI,
      apiEndpoint: ApiEndpoint.Passthrough,
    }),
    /passthrough/,
  )
}

function testAiIdentityStillResolvesPath(): void {
  const id = resolveRecordIdentity({
    path: '/v1/chat/completions',
    apiType: ApiType.OpenAI,
    apiEndpoint: ApiEndpoint.OpenAIChat,
  })
  assert.equal(id.kind, 'ai')
  assert.equal(id.provider, 'openai')
  assert.equal(id.endpoint, 'openai-chat')
}

function testAiRejectsPathMismatch(): void {
  assert.throws(
    () => resolveRecordIdentity({
      path: '/v1/messages',
      apiType: ApiType.OpenAI,
      apiEndpoint: ApiEndpoint.OpenAIChat,
    }),
  )
}

function main(): void {
  testPassthroughIdentity()
  testPassthroughRejectsMixed()
  testAiIdentityStillResolvesPath()
  testAiRejectsPathMismatch()
  console.log('record identity tests passed')
}

main()
