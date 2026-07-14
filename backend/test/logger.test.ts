import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import {
  createAppLogger,
  formatErrorChain,
  resolveLogConfig,
  serializeError,
} from '../src/logger'

class MemorySink extends Writable {
  readonly chunks: string[] = []

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString())
    callback()
  }

  text(): string {
    return this.chunks.join('')
  }
}

function testConfig(): void {
  assert.deepEqual(resolveLogConfig({}), { format: 'pretty', level: 'info' })
  assert.deepEqual(
    resolveLogConfig({ LOG_FORMAT: 'json', LOG_LEVEL: 'debug' }),
    { format: 'json', level: 'debug' },
  )
  assert.throws(() => resolveLogConfig({ LOG_FORMAT: 'xml' }), /LOG_FORMAT/)
  assert.throws(() => resolveLogConfig({ LOG_LEVEL: 'verbose' }), /LOG_LEVEL/)
}

function testJsonOutput(): void {
  const sink = new MemorySink()
  const logger = createAppLogger(
    { format: 'json', level: 'info' },
    { destination: sink, colorize: false },
  ).child({ component: 'proxy' })

  logger.info({ requestId: 'request-1', status: 200 }, 'proxy request ended')

  const record = JSON.parse(sink.text().trim()) as Record<string, unknown>
  assert.equal(record.service, 'sse-inspector')
  assert.equal(record.component, 'proxy')
  assert.equal(record.level, 30)
  assert.equal(record.msg, 'proxy request ended')
  assert.equal(record.requestId, 'request-1')
  assert.equal(record.status, 200)
}

function testPrettyOutput(): void {
  const sink = new MemorySink()
  const logger = createAppLogger(
    { format: 'pretty', level: 'info' },
    { destination: sink, colorize: true },
  ).child({ component: 'proxy' })

  logger.info({ requestId: 'request-1' }, 'proxy request started')

  assert.match(sink.text(), /\u001b\[/)
  assert.match(sink.text(), /proxy request started/)
  assert.match(sink.text(), /request-1/)
}

function testErrorCause(): void {
  const root = new Error('root failure')
  const outer = new TypeError('outer failure', { cause: root })
  const serialized = serializeError(outer)

  assert.equal(serialized.type, 'TypeError')
  assert.equal(serialized.message, 'outer failure')
  assert.match(serialized.stack ?? '', /outer failure/)
  assert.equal(serialized.cause?.type, 'Error')
  assert.equal(serialized.cause?.message, 'root failure')
  assert.match(serialized.cause?.stack ?? '', /root failure/)
  assert.equal(formatErrorChain(outer), 'TypeError: outer failure -> Error: root failure')

  const sink = new MemorySink()
  const logger = createAppLogger(
    { format: 'json', level: 'info' },
    { destination: sink, colorize: false },
  )
  logger.error({ err: serialized }, 'operation failed')
  const record = JSON.parse(sink.text().trim()) as { err: typeof serialized }
  assert.equal(record.err.type, 'TypeError')
  assert.equal(record.err.cause?.type, 'Error')
}

testConfig()
testJsonOutput()
testPrettyOutput()
testErrorCause()
console.log('logger tests passed')
