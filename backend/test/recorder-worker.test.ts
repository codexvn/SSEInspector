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
  if (result.ok) assert.deepEqual(result.value, { total: 0, openai: 0, anthropic: 0, streaming: 0, error: 0 })

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
    }
    assert.equal(detail.state, 'done')
    assert.equal(detail.apiEndpoint, 'openai-responses')
    assert.deepEqual(JSON.parse(detail.requestBody), { model: 'unknown', input: 'hello' })
    assert.equal(detail.responseBody, responseBody.toString())
  }

  worker.postMessage({ type: 'shutdown' })
  await new Promise<void>((resolve, reject) => {
    worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`Recorder Worker 退出码异常: ${code}`)))
    worker.once('error', reject)
  })
  await Promise.all([
    fs.rm(dbPath, { force: true }),
    fs.rm(`${dbPath}-wal`, { force: true }),
    fs.rm(`${dbPath}-shm`, { force: true }),
  ])
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
