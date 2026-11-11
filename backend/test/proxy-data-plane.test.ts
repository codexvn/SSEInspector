import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import express from 'express'
import type { CaptureMetadata } from '../src/recorder/protocol'
import { ApiEndpoint, ApiType } from '../src/types'

interface CapturedLogEvent {
  level: 'info' | 'warn' | 'error'
  fields: Record<string, unknown>
  message: string
}

interface CaptureObservation {
  starts: CaptureMetadata[]
  requestChunks: Array<{ id: string; chunk: Buffer }>
  requestEnds: string[]
  responseStarts: Array<{ id: string; status: number; headers: Record<string, string>; streaming: boolean }>
  responseChunks: Array<{ id: string; chunk: Buffer }>
  completes: string[]
  closed: Array<{ id: string; status: number; reason: string }>
  failed: Array<{ id: string; status: number; error: string }>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const require = createRequire(__filename)
const clientPath = require.resolve('../src/recorder/client')

const captureObservation: CaptureObservation = {
  starts: [],
  requestChunks: [],
  requestEnds: [],
  responseStarts: [],
  responseChunks: [],
  completes: [],
  closed: [],
  failed: [],
}

const recorderMock = {
  beginCapture: (metadata: CaptureMetadata) => {
    captureObservation.starts.push(metadata)
  },
  captureRequestChunk: (id: string, chunk: Uint8Array) => {
    captureObservation.requestChunks.push({ id, chunk: Buffer.from(chunk) })
  },
  endCaptureRequest: (id: string) => {
    captureObservation.requestEnds.push(id)
  },
  beginCaptureResponse: (id: string, status: number, headers: Record<string, string>, streaming: boolean) => {
    captureObservation.responseStarts.push({ id, status, headers, streaming })
  },
  captureResponseChunk: (id: string, chunk: Uint8Array) => {
    captureObservation.responseChunks.push({ id, chunk: Buffer.from(chunk) })
  },
  completeCapture: (id: string) => {
    captureObservation.completes.push(id)
  },
  closeCapture: (id: string, status: number, reason: string) => {
    captureObservation.closed.push({ id, status, reason })
  },
  failCapture: (id: string, status: number, error: string) => {
    captureObservation.failed.push({ id, status, error })
  },
  startRecorder: async () => {},
  stopRecorder: async () => {},
  recorderAvailable: () => true,
  onRecorderUiEvent: () => () => {},
  recorderRpc: async () => {},
}

// tsx 导出 getter 只读，必须在加载 proxy 前注入 mock 模块。
for (const key of Object.keys(require.cache)) {
  if (key.includes(`${path.sep}recorder${path.sep}client`) || /[\\/]proxy\.(ts|js)$/.test(key)) {
    delete require.cache[key]
  }
}
require.cache[clientPath] = {
  id: clientPath,
  filename: clientPath,
  loaded: true,
  exports: recorderMock,
} as NodeModule

const { setConfig } = require('../src/config') as typeof import('../src/config')
const { getEndpointDefinition } = require('../src/endpoints') as typeof import('../src/endpoints')
const { getLogger } = require('../src/logger') as typeof import('../src/logger')
const { handlePassthrough, handleProxy } = require('../src/proxy') as typeof import('../src/proxy')
const { initRouting, replaceRoutingConfig } = require('../src/routing') as typeof import('../src/routing')

const proxyLogger = getLogger('proxy')
const originalLoggerMethods = {
  info: proxyLogger.info,
  warn: proxyLogger.warn,
  error: proxyLogger.error,
}
const logEvents: CapturedLogEvent[] = []
proxyLogger.info = captureLogMethod('info') as typeof proxyLogger.info
proxyLogger.warn = captureLogMethod('warn') as typeof proxyLogger.warn
proxyLogger.error = captureLogMethod('error') as typeof proxyLogger.error
const passthroughLogger = getLogger('passthrough')
const originalPassthroughLoggerMethods = {
  info: passthroughLogger.info,
  warn: passthroughLogger.warn,
  error: passthroughLogger.error,
}
const passthroughLogEvents: CapturedLogEvent[] = []
passthroughLogger.info = captureLogMethod('info', passthroughLogEvents) as typeof passthroughLogger.info
passthroughLogger.warn = captureLogMethod('warn', passthroughLogEvents) as typeof passthroughLogger.warn
passthroughLogger.error = captureLogMethod('error', passthroughLogEvents) as typeof passthroughLogger.error

async function main(): Promise<void> {
  const receivedBody: Buffer[] = []
  let firstUpstreamChunkAt = 0
  let upstreamRequestEndedAt = 0
  const responseBody = Buffer.from([0, 1, 2, 127, 128, 255])
  let resolveCancelledUpstream!: () => void
  const cancelledUpstream = new Promise<void>(resolve => { resolveCancelledUpstream = resolve })
  let resolveAbortedUpload!: () => void
  const abortedUpload = new Promise<void>(resolve => { resolveAbortedUpload = resolve })

  const upstream = http.createServer((req, res) => {
    if (req.url?.includes('mode=upload-abort')) {
      req.once('aborted', resolveAbortedUpload)
      req.once('close', () => {
        if (!req.complete) resolveAbortedUpload()
      })
      req.resume()
      return
    }
    if (req.url?.includes('mode=client-close')) {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })}\n\n`)
        res.once('close', resolveCancelledUpstream)
      })
      return
    }
    req.on('data', (chunk: Buffer) => {
      if (!firstUpstreamChunkAt) firstUpstreamChunkAt = Date.now()
      receivedBody.push(chunk)
    })
    req.on('end', () => {
      upstreamRequestEndedAt = Date.now()
      res.writeHead(201, {
        'content-type': 'application/octet-stream',
        'content-length': String(responseBody.length),
        'x-byte-test': 'preserved',
      })
      res.end(responseBody)
    })
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const upstreamPort = (upstream.address() as { port: number }).port

  setConfig({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    port: 0,
    dbPath: 'unused.db',
  })

  const app = express()
  app.post('/v1/responses', (req, res) => {
    void handleProxy(req, res, getEndpointDefinition('openai-responses'))
  })
  app.post('/v1/alpha/search', (req, res) => {
    void handlePassthrough(req, res)
  })
  const proxy = app.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const proxyPort = (proxy.address() as { port: number }).port

  const uploadStartedAt = Date.now()
  const result = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/responses?trace=raw',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '10',
      },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }))
    })
    request.on('error', reject)
    request.write('12345')
    setTimeout(() => request.end('67890'), 100)
  })

  assert.ok(firstUpstreamChunkAt >= uploadStartedAt, '上游应在请求体上传期间收到首个 chunk')
  assert.ok(firstUpstreamChunkAt < upstreamRequestEndedAt, '代理不应等待完整请求体后再连接上游')
  assert.equal(Buffer.concat(receivedBody).toString(), '1234567890')
  assert.equal(result.status, 201)
  assert.equal(result.headers['x-byte-test'], 'preserved')
  assert.deepEqual(result.body, responseBody, '非流式响应不得 JSON 重编码或改变字节')

  const aiCapture = captureObservation.starts.find(start => start.path === '/v1/responses')
  assert.ok(aiCapture, 'AI 路径应触发 capture.start')
  assert.ok(UUID_RE.test(aiCapture.id), 'AI capture id 应为 UUID')
  assert.equal(aiCapture.apiType, ApiType.OpenAI)
  assert.equal(aiCapture.apiEndpoint, ApiEndpoint.OpenAIResponses)
  assert.ok(
    captureObservation.requestChunks.some(item => item.id === aiCapture.id),
    'AI 路径应观察 request chunk',
  )
  assert.ok(
    captureObservation.responseChunks.some(item => item.id === aiCapture.id),
    'AI 路径应观察 response chunk',
  )
  assert.ok(captureObservation.completes.includes(aiCapture.id), 'AI 路径应 completeCapture')

  await requestPassthrough(proxyPort)

  const passthroughCapture = captureObservation.starts.find(start => start.path === '/v1/alpha/search')
  assert.ok(passthroughCapture, 'passthrough 路径应触发 capture.start')
  assert.ok(UUID_RE.test(passthroughCapture.id), 'passthrough capture id 应为 UUID')
  assert.equal(passthroughCapture.apiType, ApiType.Passthrough)
  assert.equal(passthroughCapture.apiEndpoint, ApiEndpoint.Passthrough)
  assert.equal(passthroughCapture.method, 'POST')
  assert.ok(
    captureObservation.requestChunks.some(item => item.id === passthroughCapture.id),
    'passthrough 路径应观察 request chunk',
  )
  assert.ok(
    captureObservation.responseChunks.some(item => item.id === passthroughCapture.id),
    'passthrough 路径应观察 response chunk',
  )
  assert.ok(
    captureObservation.responseStarts.some(item => item.id === passthroughCapture.id && item.status === 201),
    'passthrough 路径应 beginCaptureResponse',
  )
  assert.ok(
    captureObservation.completes.includes(passthroughCapture.id),
    'passthrough 路径应 completeCapture',
  )

  await cancelStreamingResponse(proxyPort)
  await Promise.race([
    cancelledUpstream,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('客户端关闭后上游响应未被终止')), 2000)),
  ])

  await abortRequestUpload(proxyPort)
  await Promise.race([
    abortedUpload,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('客户端中断上传后上游请求未被终止')), 2000)),
  ])

  // ---- 多上游分流：规则命中走上游 B，未命中走默认，两者皆无时 503 ----
  const upstreamBSeen: string[] = []
  const upstreamB = http.createServer((req, res) => {
    upstreamBSeen.push(req.url ?? '')
    res.writeHead(202, { 'content-type': 'application/json', 'x-upstream-b': '1' })
    res.end('{"from":"b"}')
  })
  upstreamB.listen(0, '127.0.0.1')
  await once(upstreamB, 'listening')
  const upstreamBPort = (upstreamB.address() as { port: number }).port
  const upstreamAUrl = `http://127.0.0.1:${upstreamPort}`

  const routingFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sse-proxy-routing-')), 'routing.json')
  initRouting({ cliUpstream: null, filePath: routingFile })
  replaceRoutingConfig({
    defaultUpstream: upstreamAUrl,
    routes: [
      { id: 'b1', name: 'beta 分流', enabled: true, prefix: '/v1/alpha', upstream: `http://127.0.0.1:${upstreamBPort}` },
    ],
  })

  // 命中规则：同一透传路径改走上游 B，记录的 upstreamUrl 指向 B
  const betaResult = await postJson(proxyPort, '/v1/alpha/search')
  assert.equal(betaResult.status, 202)
  assert.equal(betaResult.headers['x-upstream-b'], '1')
  assert.deepEqual(upstreamBSeen, ['/v1/alpha/search'])
  const betaCapture = captureObservation.starts.filter(start => start.path === '/v1/alpha/search').at(-1)
  assert.ok(betaCapture, '分流请求应触发 capture.start')
  assert.ok(betaCapture.upstreamUrl.includes(`:${upstreamBPort}`), '记录的 upstreamUrl 应指向规则命中的上游')

  // 未命中规则：默认上游兜底（/v1/responses 不在 /v1/alpha 前缀内）
  const defaultResult = await postJson(proxyPort, '/v1/responses')
  assert.equal(defaultResult.status, 201)
  assert.deepEqual(upstreamBSeen, ['/v1/alpha/search'], '未命中路径不应到达上游 B')

  // 清空默认上游后未命中路径：503 明确拒绝，且不产生新录制
  const startsBeforeReject = captureObservation.starts.length
  replaceRoutingConfig({ defaultUpstream: null, routes: [] })
  const rejected = await postJson(proxyPort, '/v1/responses')
  assert.equal(rejected.status, 503)
  assert.ok(rejected.body.toString().includes('未匹配任何分流规则'), '拒绝响应应携带中文错误说明')
  assert.equal(captureObservation.starts.length, startsBeforeReject, '被拒绝请求不应产生录制')
  assert.ok(
    logEvents.some(event => event.level === 'warn' && event.message === 'no upstream resolved, rejecting request'),
    '拒绝路径应输出 warn 日志',
  )

  await Promise.all([
    new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())),
    new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve())),
    new Promise<void>((resolve, reject) => upstreamB.close(error => error ? reject(error) : resolve())),
  ])

  assert.ok(logEvents.some(event => event.message === 'proxy request started' && event.fields.method === 'POST'))
  assert.ok(logEvents.some(event => event.message === 'proxy request ended' && event.fields.reason === 'upstream_complete'))
  assert.ok(logEvents.some(event => event.message === 'proxy request ended' && event.fields.reason === 'downstream_closed'))
  assert.equal(logEvents.filter(event => event.level === 'warn' && event.fields.reason === 'request_aborted').length, 1)
  assert.ok(logEvents.every(event => typeof event.fields.requestId === 'string' && event.fields.requestId !== '-'))
  assert.ok(logEvents.every(event => UUID_RE.test(String(event.fields.requestId))))
  const passthroughStarted = passthroughLogEvents.find(event => event.message === 'proxy request started')
  const passthroughEnded = passthroughLogEvents.find(
    event => event.message === 'proxy request ended' && event.fields.reason === 'upstream_complete',
  )
  assert.ok(passthroughStarted, 'passthrough 应输出 started 日志')
  assert.ok(passthroughEnded, 'passthrough 应输出 ended 日志')
  assert.ok(UUID_RE.test(String(passthroughStarted.fields.requestId)), 'passthrough started 日志应含真实 requestId')
  assert.ok(UUID_RE.test(String(passthroughEnded.fields.requestId)), 'passthrough ended 日志应含真实 requestId')
  assert.equal(passthroughStarted.fields.requestId, passthroughCapture.id)
  assert.equal(passthroughEnded.fields.requestId, passthroughCapture.id)

  console.log('proxy data plane tests passed')
}

async function cancelStreamingResponse(proxyPort: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/responses?mode=client-close',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '2' },
    }, response => {
      response.once('data', () => response.destroy())
      response.once('close', resolve)
      response.once('error', error => (error as NodeJS.ErrnoException).code === 'ECONNRESET' ? resolve() : reject(error))
    })
    request.once('error', reject)
    request.end('{}')
  })
}

async function requestPassthrough(proxyPort: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/alpha/search',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '2' },
    }, response => {
      response.resume()
      response.once('end', resolve)
      response.once('error', reject)
    })
    request.once('error', reject)
    request.end('{}')
  })
}

async function abortRequestUpload(proxyPort: number): Promise<void> {
  await new Promise<void>(resolve => {
    const request = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/responses?mode=upload-abort',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '10' },
    })
    request.once('error', () => resolve())
    request.write('12345')
    setTimeout(() => {
      request.destroy()
      resolve()
    }, 50)
  })
}

/** 分流场景复用的最小 POST：返回状态、头与响应体 */
async function postJson(
  proxyPort: number,
  requestPath: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: requestPath,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '2' },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }))
    })
    request.once('error', reject)
    request.end('{}')
  })
}

main().catch(error => {
  console.error(formatErrorChain(error))
  process.exitCode = 1
}).finally(() => {
  proxyLogger.info = originalLoggerMethods.info
  proxyLogger.warn = originalLoggerMethods.warn
  proxyLogger.error = originalLoggerMethods.error
  passthroughLogger.info = originalPassthroughLoggerMethods.info
  passthroughLogger.warn = originalPassthroughLoggerMethods.warn
  passthroughLogger.error = originalPassthroughLoggerMethods.error
})

function captureLogMethod(level: CapturedLogEvent['level'], events = logEvents) {
  return (fieldsOrMessage: unknown, message?: string) => {
    events.push({
      level,
      fields: typeof fieldsOrMessage === 'object' && fieldsOrMessage !== null
        ? fieldsOrMessage as Record<string, unknown>
        : {},
      message: message ?? String(fieldsOrMessage),
    })
  }
}

function formatErrorChain(error: unknown): string {
  const messages: string[] = []
  let current: unknown = error
  while (current) {
    if (current instanceof Error) {
      messages.push(`${current.name}: ${current.message}`)
      current = current.cause
    } else {
      messages.push(String(current))
      break
    }
  }
  return messages.join(' -> ')
}
