import assert from 'node:assert/strict'
import { DeferredCaptureQueue } from '../src/recorder/capture-queue'

function testDefersCopiesUntilFlush(): void {
  const scheduled: Array<() => void> = []
  const delivered: Array<{ id: string; chunk: Uint8Array }> = []
  const source = Uint8Array.from([1, 2, 3])
  const queue = new DeferredCaptureQueue({
    schedule: callback => scheduled.push(callback),
    deliver: item => delivered.push({ id: item.id, chunk: item.chunk }),
  })

  queue.enqueue('response', 'request-1', source)
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

function testEnqueueNeverTruncatesAcrossLargeVolume(): void {
  const scheduled: Array<() => void> = []
  const delivered: number[] = []
  const queue = new DeferredCaptureQueue({
    maxDrainBytes: 3,
    schedule: callback => scheduled.push(callback),
    deliver: item => delivered.push(item.chunk.byteLength),
  })

  for (let i = 0; i < 5; i++) {
    queue.enqueue('response', 'r1', Uint8Array.from([1, 2, 3]))
  }
  assert.equal(queue.pendingBytes, 15)

  while (scheduled.length) scheduled.shift()?.()
  assert.deepEqual(delivered, [3, 3, 3, 3, 3])
  queue.acknowledge(15)
  assert.equal(queue.pendingBytes, 0)
}

function testControlMessagesRemainOrderedAcrossBoundedDrains(): void {
  const scheduled: Array<() => void> = []
  const events: string[] = []
  const queue = new DeferredCaptureQueue({
    maxDrainBytes: 3,
    schedule: callback => scheduled.push(callback),
    deliver: item => events.push(`${item.kind}:${item.chunk.byteLength}`),
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
    schedule: callback => scheduled.push(callback),
    deliver: () => assert.fail('不应投递字节'),
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
  testEnqueueNeverTruncatesAcrossLargeVolume()
  testControlMessagesRemainOrderedAcrossBoundedDrains()
  await testIdleWaitsForScheduledControls()
  console.log('recorder capture queue tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
