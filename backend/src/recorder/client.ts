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
  WsCaptureCloseReason,
} from './protocol';
import { DeferredCaptureItem, DeferredCaptureQueue } from './capture-queue';
import { getLogger, serializeError } from '../logger';

const MAX_CAPTURE_DRAIN_BYTES = 1024 * 1024;
const logger = getLogger('recorder');
const events = new EventEmitter();
events.setMaxListeners(500);

let worker: Worker | null = null;
let ready = false;
let stopping = false;
let restartAttempt = 0;
let correlationId = 0;
let stopPromise: Promise<void> | null = null;
const activeCaptures = new Set<string>();
/** WebSocket 连接级 capture：deliver 时据此把队列 chunk 映射为 capture.ws_chunk */
const wsCaptures = new Set<string>();
const pendingRpc = new Map<number, {
  resolve(value: unknown): void;
  reject(error: Error): void;
}>();
const captureQueue = new DeferredCaptureQueue({
  maxDrainBytes: MAX_CAPTURE_DRAIN_BYTES,
  schedule: callback => setImmediate(callback),
  deliver: deliverCaptureChunk,
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

/** WebSocket 连接开启录制：连接 id 同时登记到 activeCaptures 与 wsCaptures */
export function beginWsCapture(metadata: CaptureMetadata): void {
  if (!recorderAvailable()) return;
  activeCaptures.add(metadata.id);
  wsCaptures.add(metadata.id);
  post({ type: 'capture.ws_open', metadata });
}

/** WebSocket 双向原始字节 tee：复用同一延迟队列与 ack 背压，方向复用 request/response 两种 kind */
export function wsCaptureChunk(id: string, dir: 'request' | 'response', chunk: Uint8Array): void {
  if (!recorderAvailable() || !activeCaptures.has(id)) return;
  captureQueue.enqueue(dir, id, chunk);
}

/**
 * WebSocket 连接结束录制。ws_close 经队列尾投递，保证排在已入队 chunk 之后；
 * wsCaptures 延迟到投递时刻清理，使仍在队列中的 chunk 继续按 ws 消息映射。
 */
export function endWsCapture(id: string, reason: WsCaptureCloseReason, error?: string): void {
  if (!activeCaptures.delete(id)) return;
  captureQueue.enqueueControl(() => {
    postQueued({ type: 'capture.ws_close', id, reason, error });
    wsCaptures.delete(id);
  });
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
  captureQueue.clear();

  const current = worker;
  if (!current) return;
  current.postMessage({ type: 'shutdown' } satisfies MainToRecorderMessage);

  const remainingMs = Math.max(0, deadline - Date.now());
  const forceWindowMs = Math.min(1000, remainingMs);
  const gracefulMs = Math.max(0, remainingMs - forceWindowMs);
  if (await waitForWorkerExit(current, gracefulMs)) return;
  if (worker !== current) return;

  logger.warn({ timeoutMs }, 'Recorder Worker graceful shutdown timed out');
  const termination = current.terminate()
    .then(() => undefined)
    .catch(error => {
      logger.error({ err: serializeError(error) }, 'Recorder Worker forced termination failed');
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
  if (!recorderAvailable() || !activeCaptures.has(id)) return;
  const kind = message.type === 'capture.request_chunk' ? 'request' : 'response';
  captureQueue.enqueue(kind, id, chunk);
}

function deliverCaptureChunk(item: DeferredCaptureItem): void {
  if (!ready || !worker) return;
  if (wsCaptures.has(item.id)) {
    worker!.postMessage({ type: 'capture.ws_chunk', id: item.id, dir: item.kind, chunk: item.chunk }, [item.chunk.buffer]);
    return;
  }
  const type = item.kind === 'request' ? 'capture.request_chunk' : 'capture.response_chunk';
  worker!.postMessage({ type, id: item.id, chunk: item.chunk }, [item.chunk.buffer]);
}

function finalizeCaptureQueue(id: string, message: MainToRecorderMessage): void {
  postQueued(message);
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
    logger.error({ err: serializeError(error) }, 'Recorder Worker initialization failed');
    ready = false;
    if (worker === instance) worker = null;
    await instance.terminate();
    throw error;
  }

  instance.removeAllListeners('message');
  instance.on('message', handleWorkerMessage);
  instance.on('error', error => {
    logger.error({ err: serializeError(error) }, 'Recorder Worker emitted an error');
  });
  instance.on('exit', code => {
    if (worker === instance) worker = null;
    ready = false;
    captureQueue.clear();
    activeCaptures.clear();
    wsCaptures.clear();
    rejectPendingRpc(new Error(`Recorder Worker 已退出: code=${code}`));
    if (!stopping) scheduleRestart();
  });

  if (!initial) logger.info('Recorder Worker recovered');
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
      logger.fatal({ detail: message.error }, 'Recorder Worker fatal error');
      break;
    case 'ready':
      break;
  }
}

function scheduleRestart(): void {
  const delays = [1000, 2000, 5000];
  const delay = delays[Math.min(restartAttempt, delays.length - 1)];
  restartAttempt += 1;
  logger.warn({ delayMs: delay, restartAttempt }, 'Recorder Worker unavailable; restart scheduled');
  setTimeout(() => {
    if (stopping || worker) return;
    void spawnRecorder(false).catch(error => {
      logger.error({ err: serializeError(error) }, 'Recorder Worker restart failed');
      scheduleRestart();
    });
  }, delay);
}

function rejectPendingRpc(error: Error): void {
  for (const pending of pendingRpc.values()) pending.reject(error);
  pendingRpc.clear();
}
