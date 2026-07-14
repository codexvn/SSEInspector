import path from 'path';
import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { config } from '../config';
import {
  CaptureMetadata,
  CaptureCloseReason,
  MainToRecorderMessage,
  RecorderRpcArgs,
  RecorderRpcMethod,
  RecorderToMainMessage,
  RecorderUiEvent,
} from './protocol';
import { DeferredCaptureItem, DeferredCaptureQueue } from './capture-queue';

const MAX_PENDING_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_CAPTURE_DRAIN_BYTES = 1024 * 1024;
const events = new EventEmitter();
events.setMaxListeners(500);

let worker: Worker | null = null;
let ready = false;
let stopping = false;
let restartAttempt = 0;
let correlationId = 0;
let stopPromise: Promise<void> | null = null;
const truncatedCaptures = new Set<string>();
const activeCaptures = new Set<string>();
const pendingRpc = new Map<number, {
  resolve(value: unknown): void;
  reject(error: Error): void;
}>();
const captureQueue = new DeferredCaptureQueue({
  maxPendingBytes: MAX_PENDING_CAPTURE_BYTES,
  maxDrainBytes: MAX_CAPTURE_DRAIN_BYTES,
  schedule: callback => setImmediate(callback),
  deliver: deliverCaptureChunk,
  truncate: truncateCapture,
});

export async function startRecorder(): Promise<void> {
  stopping = false;
  stopPromise = null;
  await spawnRecorder(true);
}

export function recorderAvailable(): boolean {
  return !stopping && ready && worker !== null;
}

export function onRecorderUiEvent(listener: (event: RecorderUiEvent) => void): () => void {
  events.on('ui.event', listener);
  return () => events.off('ui.event', listener);
}

export function beginCapture(metadata: CaptureMetadata): void {
  truncatedCaptures.delete(metadata.id);
  if (!recorderAvailable()) return;
  activeCaptures.add(metadata.id);
  post({ type: 'capture.start', metadata });
}

export function captureRequestChunk(id: string, chunk: Uint8Array): void {
  postCaptureChunk({ type: 'capture.request_chunk', id, chunk }, id, chunk);
}

export function endCaptureRequest(id: string): void {
  if (!activeCaptures.has(id)) return;
  captureQueue.enqueueControl(() => postQueued({ type: 'capture.request_end', id }));
}

export function beginCaptureResponse(
  id: string,
  status: number,
  headers: Record<string, string>,
  streaming: boolean,
): void {
  if (!activeCaptures.has(id)) return;
  captureQueue.enqueueControl(() => postQueued({ type: 'capture.response_start', id, status, headers, streaming }));
}

export function captureResponseChunk(id: string, chunk: Uint8Array): void {
  postCaptureChunk({ type: 'capture.response_chunk', id, chunk }, id, chunk);
}

export function completeCapture(id: string): void {
  if (!activeCaptures.delete(id)) return;
  captureQueue.enqueueControl(() => finalizeCaptureQueue(id, { type: 'capture.complete', id }));
}

export function closeCapture(id: string, status: number, reason: CaptureCloseReason): void {
  if (!activeCaptures.delete(id)) return;
  captureQueue.enqueueControl(() => finalizeCaptureQueue(id, { type: 'capture.closed', id, status, reason }));
}

export function failCapture(id: string, status: number, error: string): void {
  if (!activeCaptures.delete(id)) return;
  captureQueue.enqueueControl(() => finalizeCaptureQueue(id, { type: 'capture.failed', id, status, error }));
}

export async function recorderRpc<M extends RecorderRpcMethod>(
  method: M,
  ...args: RecorderRpcArgs[M]
): Promise<unknown> {
  if (!recorderAvailable()) throw new Error('Recorder Worker 不可用');
  const id = ++correlationId;
  return new Promise((resolve, reject) => {
    pendingRpc.set(id, { resolve, reject });
    post({ type: 'rpc', correlationId: id, method, args });
  });
}

export async function stopRecorder(timeoutMs = 5000): Promise<void> {
  if (stopPromise) return stopPromise;
  stopPromise = stopRecorderWithinDeadline(timeoutMs);
  return stopPromise;
}

async function stopRecorderWithinDeadline(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  stopping = true;
  activeCaptures.clear();
  rejectPendingRpc(new Error('Recorder Worker 正在关闭'));

  await waitForPromise(captureQueue.whenIdle(), Math.max(0, deadline - Date.now()));
  ready = false;
  truncatedCaptures.clear();
  captureQueue.clear();

  const current = worker;
  if (!current) return;
  current.postMessage({ type: 'shutdown' } satisfies MainToRecorderMessage);

  const remainingMs = Math.max(0, deadline - Date.now());
  const forceWindowMs = Math.min(1000, remainingMs);
  const gracefulMs = Math.max(0, remainingMs - forceWindowMs);
  if (await waitForWorkerExit(current, gracefulMs)) return;
  if (worker !== current) return;

  console.warn('[recorder] Worker 未在优雅关闭期限内退出，开始强制终止');
  const termination = current.terminate()
    .then(() => undefined)
    .catch(error => {
      console.error(`[recorder] 强制终止 Worker 失败: ${formatErrorChain(error)}`);
    });
  await waitForPromise(termination, Math.max(0, deadline - Date.now()));
}

function waitForWorkerExit(instance: Worker, timeoutMs: number): Promise<boolean> {
  if (worker !== instance) return Promise.resolve(true);
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      instance.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    instance.once('exit', onExit);
  });
}

function waitForPromise(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    const timeout = setTimeout(resolve, timeoutMs);
    void promise.finally(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function postCaptureChunk(message: MainToRecorderMessage, id: string, chunk: Uint8Array): void {
  if (!recorderAvailable() || !activeCaptures.has(id) || truncatedCaptures.has(id)) return;
  const kind = message.type === 'capture.request_chunk' ? 'request' : 'response';
  captureQueue.enqueue(kind, id, chunk);
}

function deliverCaptureChunk(item: DeferredCaptureItem): void {
  if (!ready || !worker) return;
  const type = item.kind === 'request' ? 'capture.request_chunk' : 'capture.response_chunk';
  worker!.postMessage({ type, id: item.id, chunk: item.chunk }, [item.chunk.buffer]);
}

function truncateCapture(id: string, pendingBytes: number): void {
  if (truncatedCaptures.has(id)) return;
  truncatedCaptures.add(id);
  postQueued({ type: 'capture.truncated', id, pendingBytes });
  console.error(`[recorder] 捕获积压超过限制，停止记录后续字节: id=${id}, pendingBytes=${pendingBytes}`);
}

function finalizeCaptureQueue(id: string, message: MainToRecorderMessage): void {
  postQueued(message);
  captureQueue.release(id);
  truncatedCaptures.delete(id);
}

function post(message: MainToRecorderMessage): void {
  if (!recorderAvailable() && message.type !== 'shutdown') return;
  worker?.postMessage(message);
}

function postQueued(message: MainToRecorderMessage): void {
  if (!ready || !worker) return;
  worker.postMessage(message);
}

async function spawnRecorder(initial: boolean): Promise<void> {
  const dev = __filename.endsWith('.ts');
  const rootDir = dev
    ? path.resolve(__dirname, '..', '..', '..')
    : path.resolve(__dirname, '..', '..');
  const bootstrap = path.join(rootDir, 'bin', 'recorder-worker.js');
  const instance = new Worker(bootstrap, {
    workerData: {
      dev,
      rootDir,
      config: {
        upstreamUrl: config.upstreamUrl,
        port: config.port,
        dbPath: config.dbPath,
        configured: true,
      },
    },
  });
  worker = instance;
  ready = false;

  try {
    await new Promise<void>((resolve, reject) => {
      const onMessage = (message: RecorderToMainMessage) => {
        if (message.type === 'ready') {
          ready = true;
          restartAttempt = 0;
          resolve();
        } else if (message.type === 'fatal') {
          reject(new Error(message.error));
        }
      };
      instance.on('message', onMessage);
      instance.once('error', reject);
      instance.once('exit', code => {
        if (!ready) reject(new Error(`Recorder Worker 初始化退出: code=${code}`));
      });
    });
  } catch (error) {
    console.error(`[recorder] Worker 初始化失败: ${formatErrorChain(error)}`);
    ready = false;
    if (worker === instance) worker = null;
    await instance.terminate();
    throw error;
  }

  instance.removeAllListeners('message');
  instance.on('message', handleWorkerMessage);
  instance.on('error', error => {
    console.error(`[recorder] Worker 错误: ${formatErrorChain(error)}`);
  });
  instance.on('exit', code => {
    if (worker === instance) worker = null;
    ready = false;
    captureQueue.clear();
    activeCaptures.clear();
    truncatedCaptures.clear();
    rejectPendingRpc(new Error(`Recorder Worker 已退出: code=${code}`));
    if (!stopping) scheduleRestart();
  });

  if (!initial) console.log('[recorder] Worker 已恢复');
}

function handleWorkerMessage(message: RecorderToMainMessage): void {
  switch (message.type) {
    case 'ack':
      captureQueue.acknowledge(message.bytes);
      break;
    case 'ui.event':
      events.emit('ui.event', message.event);
      break;
    case 'rpc.result': {
      const pending = pendingRpc.get(message.correlationId);
      if (!pending) break;
      pendingRpc.delete(message.correlationId);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(message.error));
      break;
    }
    case 'fatal':
      console.error(`[recorder] Worker fatal: ${message.error}`);
      break;
    case 'ready':
      break;
  }
}

function scheduleRestart(): void {
  const delays = [1000, 2000, 5000];
  const delay = delays[Math.min(restartAttempt, delays.length - 1)];
  restartAttempt += 1;
  console.error(`[recorder] Worker 不可用，${delay}ms 后重启`);
  setTimeout(() => {
    if (stopping || worker) return;
    void spawnRecorder(false).catch(error => {
      console.error(`[recorder] Worker 重启失败: ${formatErrorChain(error)}`);
      scheduleRestart();
    });
  }, delay);
}

function rejectPendingRpc(error: Error): void {
  for (const pending of pendingRpc.values()) pending.reject(error);
  pendingRpc.clear();
}

function formatErrorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current) {
    if (current instanceof Error) {
      messages.push(`${current.name}: ${current.message}`);
      current = current.cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  return messages.join(' -> ');
}
