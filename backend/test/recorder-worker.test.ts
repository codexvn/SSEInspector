import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Worker } from 'node:worker_threads'
import type { RecorderToMainMessage } from '../src/recorder/protocol'

async function runWorker(dev: boolean): Promise<void> {
  const rootDir = process.cwd()
  const mode = dev ? 'dev' : 'prod'
  const dbPath = path.join(os.tmpdir(), `sse-inspector-recorder-${mode}-${process.pid}-${Date.now()}.db`)
  const worker = new Worker(path.join(rootDir, 'bin', 'recorder-worker.js'), {
    stdout: true,
    stderr: true,
    env: {
      ...process.env,
      LOG_FORMAT: 'json',
      LOG_LEVEL: 'info',
    },
    workerData: {
      dev,
      rootDir,
      config: {
        upstreamUrl: 'http://127.0.0.1:1',
        port: 0,
        dbPath,
        configured: true,
      },
    },
  })
  const workerStdout: string[] = []
  const workerStderr: string[] = []
  worker.stdout?.on('data', chunk => workerStdout.push(String(chunk)))
  worker.stderr?.on('data', chunk => workerStderr.push(String(chunk)))

  await waitForMessage(worker, message => message.type === 'ready')
  worker.postMessage({
    type: 'rpc',
    correlationId: 1,
    method: 'requests.stats',
    args: [],
  })
  const result = await waitForMessage(worker, message => message.type === 'rpc.result' && message.correlationId === 1)
  assert.equal(result.type, 'rpc.result')
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.value, {
    total: 0,
    openai: 0,
    anthropic: 0,
    passthrough: 0,
    streaming: 0,
    error: 0,
  })

  const captureId = `${mode}-capture`
  const requestBody = Buffer.from(JSON.stringify({ model: 'unknown', input: 'hello' }))
  const responseBody = Buffer.from(JSON.stringify({ id: 'response-1', object: 'response', output: [], usage: null }))
  worker.postMessage({
    type: 'capture.start',
    metadata: {
      id: captureId,
      startedAt: Date.now(),
      timestamp: new Date().toISOString(),
      method: 'POST',
      path: '/v1/responses',
      upstreamUrl: 'http://127.0.0.1:1/v1/responses',
      requestHeaders: { 'content-type': 'application/json' },
      apiType: 'openai',
      apiEndpoint: 'openai-responses',
    },
  })
  worker.postMessage({ type: 'capture.request_chunk', id: captureId, chunk: Uint8Array.from(requestBody) })
  worker.postMessage({ type: 'capture.request_end', id: captureId })
  worker.postMessage({
    type: 'capture.response_start',
    id: captureId,
    status: 200,
    headers: { 'content-type': 'application/json' },
    streaming: false,
  })
  worker.postMessage({ type: 'capture.response_chunk', id: captureId, chunk: Uint8Array.from(responseBody) })
  worker.postMessage({ type: 'capture.complete', id: captureId })
  worker.postMessage({ type: 'rpc', correlationId: 2, method: 'requests.detail', args: [captureId] })
  const detailResult = await waitForMessage(
    worker,
    message => message.type === 'rpc.result' && message.correlationId === 2,
  )
  assert.equal(detailResult.type, 'rpc.result')
  assert.equal(detailResult.ok, true)
  if (detailResult.ok) {
    const detail = detailResult.value as {
      state: string
      apiEndpoint: string
      requestBody: string
      responseBody: string
      tokenBreakdown?: unknown
    }
    assert.equal(detail.state, 'done')
    assert.equal(detail.apiEndpoint, 'openai-responses')
    assert.deepEqual(JSON.parse(detail.requestBody), { model: 'unknown', input: 'hello' })
    assert.equal(detail.responseBody, responseBody.toString())
    assert.equal(detail.tokenBreakdown, undefined)
  }

  await assertClientCloseCapture(worker, mode, true, 3)
  await assertClientCloseCapture(worker, mode, false, 4)
  await assertRequestAbortedCapture(worker, mode, 6)
  await assertPassthroughCapture(worker, mode, 5)
  await assertPassthroughClientClose(worker, mode, 7)

  worker.postMessage({ type: 'shutdown' })
  await new Promise<void>((resolve, reject) => {
    worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`Recorder Worker 退出码异常: ${code}`)))
    worker.once('error', reject)
  })
  const workerLogs = workerStdout
    .join('')
    .split(/\r?\n/)
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as Record<string, unknown>)
  const incomplete = workerLogs.filter(log => log.msg === 'captured response is incomplete')
  assert.equal(incomplete.length, 1)
  assert.equal(incomplete[0].component, 'recorder-worker')
  assert.equal(incomplete[0].reason, 'downstream_closed')
  assert.equal(incomplete[0].status, 200)
  assert.equal(typeof incomplete[0].durationMs, 'number')
  assert.doesNotMatch(
    workerStdout.join('') + workerStderr.join(''),
    /请求体解码失败|非流式响应 JSON 解析失败/,
  )
  await Promise.all([
    fs.rm(dbPath, { force: true }),
    fs.rm(`${dbPath}-wal`, { force: true }),
    fs.rm(`${dbPath}-shm`, { force: true }),
  ])
}

async function assertPassthroughCapture(worker: Worker, mode: string, correlationId: number): Promise<void> {
  const captureId = `${mode}-passthrough`
  const requestBody = Buffer.from('plain-text-request-body', 'utf8')
  const responseBody = Buffer.from('not-json-response-body', 'utf8')
  worker.postMessage({
    type: 'capture.start',
    metadata: {
      id: captureId,
      startedAt: Date.now(),
      timestamp: new Date().toISOString(),
      method: 'GET',
      path: '/healthz',
      upstreamUrl: 'http://127.0.0.1:1/healthz',
      requestHeaders: { 'content-type': 'text/plain' },
      apiType: 'passthrough',
      apiEndpoint: 'passthrough',
    },
  })
  worker.postMessage({ type: 'capture.request_chunk', id: captureId, chunk: Uint8Array.from(requestBody) })
  worker.postMessage({ type: 'capture.request_end', id: captureId })
  worker.postMessage({
    type: 'capture.response_start',
    id: captureId,
    status: 200,
    headers: { 'content-type': 'text/plain' },
    streaming: false,
  })
  worker.postMessage({ type: 'capture.response_chunk', id: captureId, chunk: Uint8Array.from(responseBody) })
  worker.postMessage({ type: 'capture.complete', id: captureId })
  worker.postMessage({ type: 'rpc', correlationId, method: 'requests.detail', args: [captureId] })
  const detailResult = await waitForMessage(
    worker,
    message => message.type === 'rpc.result' && message.correlationId === correlationId,
  )
  assert.equal(detailResult.type, 'rpc.result')
  assert.equal(detailResult.ok, true)
  if (!detailResult.ok) return
  const detail = detailResult.value as {
    state: string
    apiType: string
    apiEndpoint: string
    requestBody: string | null
    responseBody?: string
    responseContent: unknown
    apiUsage?: string
  }
  assert.equal(detail.state, 'done')
  assert.equal(detail.apiType, 'passthrough')
  assert.equal(detail.apiEndpoint, 'passthrough')
  assert.equal(JSON.parse(detail.requestBody ?? 'null'), 'plain-text-request-body')
  assert.equal(detail.responseBody, 'not-json-response-body')
  assert.equal(detail.responseContent, null)
  assert.equal(detail.apiUsage, undefined)

  const toolsCorrelationId = correlationId + 100
  worker.postMessage({ type: 'rpc', correlationId: toolsCorrelationId, method: 'tools.list', args: [captureId] })
  const toolsResult = await waitForMessage(
    worker,
    message => message.type === 'rpc.result' && message.correlationId === toolsCorrelationId,
  )
  assert.equal(toolsResult.type, 'rpc.result')
  assert.equal(toolsResult.ok, true)
  if (toolsResult.ok) {
    assert.deepEqual(toolsResult.value, { toolCalls: [] })
  }
}

async function assertPassthroughClientClose(worker: Worker, mode: string, correlationId: number): Promise<void> {
  const captureId = `${mode}-passthrough-client-close`
  const requestBody = Buffer.from('stream-req', 'utf8')
  const responseText = 'chunk-one\nchunk-two\n'
  worker.postMessage({
    type: 'capture.start',
    metadata: {
      id: captureId,
      startedAt: Date.now(),
      timestamp: new Date().toISOString(),
      method: 'GET',
      path: '/metrics',
      upstreamUrl: 'http://127.0.0.1:1/metrics',
      requestHeaders: { accept: 'text/plain' },
      apiType: 'passthrough',
      apiEndpoint: 'passthrough',
    },
  })
  worker.postMessage({ type: 'capture.request_chunk', id: captureId, chunk: Uint8Array.from(requestBody) })
  worker.postMessage({ type: 'capture.request_end', id: captureId })
  worker.postMessage({
    type: 'capture.response_start',
    id: captureId,
    status: 200,
    headers: { 'content-type': 'text/plain' },
    streaming: true,
  })
  worker.postMessage({
    type: 'capture.response_chunk',
    id: captureId,
    chunk: Uint8Array.from(Buffer.from(responseText)),
  })
  worker.postMessage({ type: 'capture.closed', id: captureId, status: 200, reason: 'downstream_closed' })
  worker.postMessage({ type: 'rpc', correlationId, method: 'requests.detail', args: [captureId] })
  const result = await waitForMessage(
    worker,
    message => message.type === 'rpc.result' && message.correlationId === correlationId,
  )
  assert.equal(result.type, 'rpc.result')
  assert.equal(result.ok, true)
  if (!result.ok) return
  const detail = result.value as {
    state: string
    finished: string
    error?: string
    apiType: string
    apiEndpoint: string
    responseBody?: string
    responseContent: unknown
    apiUsage?: string
  }
  // 透传 client_close：有 response_start 即完成，不走 isTerminalSSE / incomplete warning
  assert.equal(detail.state, 'done')
  assert.equal(detail.finished, 'client_close')
  assert.equal(detail.error, undefined)
  assert.equal(detail.apiType, 'passthrough')
  assert.equal(detail.apiEndpoint, 'passthrough')
  assert.equal(detail.responseBody, responseText)
  assert.equal(detail.responseContent, null)
  assert.equal(detail.apiUsage, undefined)
}

async function assertRequestAbortedCapture(worker: Worker, mode: string, correlationId: number): Promise<void> {
  const captureId = `${mode}-request-aborted`
  worker.postMessage({
    type: 'capture.start',
    metadata: {
      id: captureId,
      startedAt: Date.now(),
      timestamp: new Date().toISOString(),
      method: 'POST',
      path: '/v1/responses',
      upstreamUrl: 'http://127.0.0.1:1/v1/responses',
      requestHeaders: { 'content-type': 'application/json' },
      apiType: 'openai',
      apiEndpoint: 'openai-responses',
    },
  })
  worker.postMessage({
    type: 'capture.request_chunk',
    id: captureId,
    chunk: Uint8Array.from(Buffer.from('{"model":')),
  })
  worker.postMessage({ type: 'capture.closed', id: captureId, status: 499, reason: 'request_aborted' })
  worker.postMessage({ type: 'rpc', correlationId, method: 'requests.detail', args: [captureId] })

  const result = await waitForMessage(
    worker,
    message => message.type === 'rpc.result' && message.correlationId === correlationId,
  )
  assert.equal(result.type, 'rpc.result')
  assert.equal(result.ok, true)
  if (!result.ok) return
  const detail = result.value as {
    state: string
    finished: string
    error: string
    requestBody: string | null
    responseBody?: string
    responseContent: unknown
  }
  assert.equal(detail.state, 'error')
  assert.equal(detail.finished, 'client_close')
  assert.equal(detail.error, '客户端在请求上传完成前断开')
  assert.equal(detail.requestBody, null)
  assert.equal(detail.responseBody, undefined)
  assert.equal(detail.responseContent, null)
}

async function assertClientCloseCapture(
  worker: Worker,
  mode: string,
  terminal: boolean,
  correlationId: number,
): Promise<void> {
  const captureId = `${mode}-client-close-${terminal ? 'terminal' : 'partial'}`
  const requestBody = Buffer.from(JSON.stringify({ model: 'gpt-test', input: 'hello', stream: true }))
  const responseText = terminal
    ? `data: ${JSON.stringify({ type: 'response.completed', response: { id: captureId, status: 'completed', output: [], usage: { input_tokens: 2, output_tokens: 1 } } })}\n\n`
    : `data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' })}\n\n`

  worker.postMessage({
    type: 'capture.start',
    metadata: {
      id: captureId,
      startedAt: Date.now(),
      timestamp: new Date().toISOString(),
      method: 'POST',
      path: '/v1/responses',
      upstreamUrl: 'http://127.0.0.1:1/v1/responses',
      requestHeaders: { 'content-type': 'application/json' },
      apiType: 'openai',
      apiEndpoint: 'openai-responses',
    },
  })
  worker.postMessage({ type: 'capture.request_chunk', id: captureId, chunk: Uint8Array.from(requestBody) })
  worker.postMessage({ type: 'capture.request_end', id: captureId })
  worker.postMessage({
    type: 'capture.response_start',
    id: captureId,
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    streaming: true,
  })
  worker.postMessage({ type: 'capture.response_chunk', id: captureId, chunk: Uint8Array.from(Buffer.from(responseText)) })
  worker.postMessage({ type: 'capture.closed', id: captureId, status: 200, reason: 'downstream_closed' })
  worker.postMessage({ type: 'rpc', correlationId, method: 'requests.detail', args: [captureId] })

  const result = await waitForMessage(
    worker,
    message => message.type === 'rpc.result' && message.correlationId === correlationId,
  )
  assert.equal(result.type, 'rpc.result')
  assert.equal(result.ok, true)
  if (!result.ok) return
  const detail = result.value as { state: string; finished: string; error?: string; responseBody: string }
  assert.equal(detail.state, terminal ? 'done' : 'error')
  assert.equal(detail.finished, 'client_close')
  assert.equal(detail.error, terminal ? undefined : '客户端在响应完成前断开')
  assert.equal(detail.responseBody, responseText)
}

function waitForMessage(
  worker: Worker,
  predicate: (message: RecorderToMainMessage) => boolean,
): Promise<RecorderToMainMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('等待 Recorder Worker 消息超时'))
    }, 15000)
    const onMessage = (message: RecorderToMainMessage) => {
      if (message.type === 'fatal') {
        cleanup()
        reject(new Error(message.error))
        return
      }
      if (!predicate(message)) return
      cleanup()
      resolve(message)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onExit = (code: number) => {
      cleanup()
      reject(new Error(`Recorder Worker 等待消息期间退出: ${code}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
    }
    worker.on('message', onMessage)
    worker.on('error', onError)
    worker.on('exit', onExit)
  })
}

async function main(): Promise<void> {
  await runWorker(true)
  await fs.access(path.join(process.cwd(), 'dist', 'recorder', 'worker.js'))
  await runWorker(false)
  console.log('recorder worker dev/prod tests passed')
}

main().catch(error => {
  console.error(formatErrorChain(error))
  process.exitCode = 1
})

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
