import assert from 'node:assert/strict'
import { DeferredCaptureQueue } from '../src/recorder/capture-queue'

function testDefersCopiesUntilFlush(): void {
  const scheduled: Array<() => void> = []
  const delivered: Array<{ id: string; chunk: Uint8Array }> = []
  const source = Uint8Array.from([1, 2, 3])
  const queue = new DeferredCaptureQueue({
    maxPendingBytes: 16,
    schedule: callback => scheduled.push(callback),
    deliver: item => delivered.push({ id: item.id, chunk: item.chunk }),
    truncate: () => assert.fail('不应截断'),
  })

  assert.equal(queue.enqueue('response', 'request-1', source), true)
  assert.equal(delivered.length, 0)
  source[0] = 9
  scheduled.shift()?.()

  assert.equal(delivered.length, 1)
  assert.deepEqual(Array.from(delivered[0].chunk), [9, 2, 3])
  assert.notEqual(delivered[0].chunk, source)
  assert.equal(queue.pendingBytes, 3)
  queue.acknowledge(3)
  assert.equal(queue.pendingBytes, 0)
}

function testPendingLimitIncludesDeferredBytes(): void {
  const truncated: Array<{ id: string; pendingBytes: number }> = []
  const events: string[] = []
  const scheduled: Array<() => void> = []
  const queue = new DeferredCaptureQueue({
    maxPendingBytes: 4,
    schedule: callback => scheduled.push(callback),
    deliver: item => events.push(`chunk:${item.chunk.byteLength}`),
    truncate: (id, pendingBytes) => {
      events.push('truncated')
      truncated.push({ id, pendingBytes })
    },
  })

  assert.equal(queue.enqueue('request', 'request-1', Uint8Array.from([1, 2, 3])), true)
  assert.equal(queue.enqueue('request', 'request-1', Uint8Array.from([4, 5])), false)
  assert.deepEqual(events, [])
  scheduled.shift()?.()
  assert.deepEqual(truncated, [{ id: 'request-1', pendingBytes: 3 }])
  assert.deepEqual(events, ['chunk:3', 'truncated'])
  assert.equal(queue.pendingBytes, 3)
  queue.acknowledge(3)
  queue.release('request-1')
  assert.equal(queue.enqueue('request', 'request-1', Uint8Array.from([6])), true)
}

function testControlMessagesRemainOrderedAcrossBoundedDrains(): void {
  const scheduled: Array<() => void> = []
  const events: string[] = []
  const queue = new DeferredCaptureQueue({
    maxPendingBytes: 16,
    maxDrainBytes: 3,
    schedule: callback => scheduled.push(callback),
    deliver: item => events.push(`${item.kind}:${item.chunk.byteLength}`),
    truncate: () => assert.fail('不应截断'),
  })

  queue.enqueue('request', 'request-1', Uint8Array.from([1, 2, 3]))
  queue.enqueueControl(() => events.push('request_end'))
  queue.enqueue('response', 'request-1', Uint8Array.from([4, 5, 6]))

  assert.deepEqual(events, [])
  scheduled.shift()?.()
  assert.deepEqual(events, ['request:3', 'request_end'])
  assert.equal(scheduled.length, 1)

  scheduled.shift()?.()
  assert.deepEqual(events, ['request:3', 'request_end', 'response:3'])
}

async function testIdleWaitsForScheduledControls(): Promise<void> {
  const scheduled: Array<() => void> = []
  const queue = new DeferredCaptureQueue({
    maxPendingBytes: 16,
    schedule: callback => scheduled.push(callback),
    deliver: () => assert.fail('不应投递字节'),
    truncate: () => assert.fail('不应截断'),
  })
  let resolved = false
  queue.enqueueControl(() => undefined)
  const idle = queue.whenIdle().then(() => { resolved = true })

  await Promise.resolve()
  assert.equal(resolved, false)
  scheduled.shift()?.()
  await idle
  assert.equal(resolved, true)
}

async function main(): Promise<void> {
  testDefersCopiesUntilFlush()
  testPendingLimitIncludesDeferredBytes()
  testControlMessagesRemainOrderedAcrossBoundedDrains()
  await testIdleWaitsForScheduledControls()
  console.log('recorder capture queue tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
