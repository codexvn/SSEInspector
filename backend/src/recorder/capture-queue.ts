export type CaptureChunkKind = 'request' | 'response'

export interface DeferredCaptureItem {
  kind: CaptureChunkKind
  id: string
  chunk: Uint8Array<ArrayBuffer>
}

interface DeferredCaptureQueueOptions {
  maxDrainBytes?: number
  schedule(callback: () => void): void
  deliver(item: DeferredCaptureItem): void
}

interface QueuedChunkItem {
  type: 'chunk'
  kind: CaptureChunkKind
  id: string
  chunk: Uint8Array
}

interface QueuedControlItem {
  type: 'control'
  deliver(): void
}

type QueuedCaptureItem = QueuedChunkItem | QueuedControlItem

export class DeferredCaptureQueue {
  private readonly items: QueuedCaptureItem[] = []
  private readonly idleWaiters: Array<() => void> = []
  private scheduled = false
  private totalPendingBytes = 0

  constructor(private readonly options: DeferredCaptureQueueOptions) {}

  get pendingBytes(): number {
    return this.totalPendingBytes
  }

  enqueue(kind: CaptureChunkKind, id: string, chunk: Uint8Array): void {
    this.items.push({ type: 'chunk', kind, id, chunk })
    this.totalPendingBytes += chunk.byteLength
    this.ensureScheduled()
  }

  enqueueControl(deliver: () => void): void {
    this.items.push({ type: 'control', deliver })
    this.ensureScheduled()
  }

  whenIdle(): Promise<void> {
    if (this.items.length === 0) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.push(resolve))
  }

  private drain(): void {
    this.scheduled = false
    const maxDrainBytes = this.options.maxDrainBytes ?? Number.POSITIVE_INFINITY
    let drainedBytes = 0
    let processedItems = 0

    while (processedItems < this.items.length) {
      const item = this.items[processedItems]
      if (item.type === 'chunk' && drainedBytes > 0 && drainedBytes + item.chunk.byteLength > maxDrainBytes) break
      processedItems += 1
      if (item.type === 'control') {
        item.deliver()
        continue
      }
      this.options.deliver({ ...item, chunk: Uint8Array.from(item.chunk) })
      drainedBytes += item.chunk.byteLength
    }

    if (processedItems > 0) this.items.splice(0, processedItems)
    if (this.items.length > 0) this.ensureScheduled()
    else this.resolveIdleWaiters()
  }

  acknowledge(bytes: number): void {
    this.totalPendingBytes = Math.max(0, this.totalPendingBytes - bytes)
  }

  clear(): void {
    this.items.length = 0
    this.totalPendingBytes = 0
    this.scheduled = false
    this.resolveIdleWaiters()
  }

  private ensureScheduled(): void {
    if (this.scheduled) return
    this.scheduled = true
    this.options.schedule(() => this.drain())
  }

  private resolveIdleWaiters(): void {
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }
}
