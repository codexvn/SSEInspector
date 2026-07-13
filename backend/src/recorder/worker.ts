import { parentPort, workerData } from 'worker_threads';
import { TextDecoder } from 'util';
import { setConfig } from '../config';
import { MainToRecorderMessage, RecorderRpcMethod, RecorderToMainMessage, CaptureMetadata } from './protocol';
import { RecordedRequest, MergedContent } from '../types';

if (!parentPort) throw new Error('Recorder Worker 缺少 parentPort');
setConfig(workerData.config);

interface CaptureState {
  metadata: CaptureMetadata;
  requestChunks: Buffer[];
  responseDecoder: TextDecoder;
  responseText: string;
  requestBody?: unknown;
  requestDecodeError?: string;
  responseHeaders?: Record<string, string>;
  responseStatus?: number;
  streaming: boolean;
  truncated: boolean;
  record?: RecordedRequest;
  lastPublishedAt: number;
}

const captures = new Map<string, CaptureState>();
const activeUiStates = new Map<string, RecordedRequest['state']>();
let shuttingDown = false;
let messageChain = Promise.resolve();

void initialize().catch(error => {
  const detail = formatErrorChain(error);
  console.error(`[recorder-worker] 初始化失败: ${detail}`);
  send({ type: 'fatal', error: detail });
  process.exitCode = 1;
});

async function initialize(): Promise<void> {
  const db = require('../db') as typeof import('../db');
  const store = require('../store') as typeof import('../store');
  await db.initDb();
  store.onUpdate(summary => {
    const previousState = activeUiStates.get(summary.id);
    const structural = previousState === undefined || previousState !== summary.state;
    if (summary.state === 'streaming') activeUiStates.set(summary.id, summary.state);
    else activeUiStates.delete(summary.id);
    send({
      type: 'ui.event',
      event: {
        recordId: summary.id,
        structural,
        payload: `data: ${JSON.stringify({ type: 'update', record: summary })}\n\n`,
      },
    });
  });
  parentPort!.on('message', (message: MainToRecorderMessage) => {
    messageChain = messageChain
      .then(() => handleMessage(message))
      .catch(error => {
        const detail = formatErrorChain(error);
        console.error(`[recorder-worker] 消息处理失败: ${detail}`);
        send({ type: 'fatal', error: detail });
        process.exit(1);
      });
  });
  send({ type: 'ready' });
}

async function handleMessage(message: MainToRecorderMessage): Promise<void> {
  switch (message.type) {
    case 'capture.start':
      captures.set(message.metadata.id, {
        metadata: message.metadata,
        requestChunks: [],
        responseDecoder: new TextDecoder('utf-8'),
        responseText: '',
        streaming: false,
        truncated: false,
        lastPublishedAt: 0,
      });
      return;
    case 'capture.request_chunk': {
      const state = captures.get(message.id);
      if (state && !state.truncated) state.requestChunks.push(Buffer.from(message.chunk));
      send({ type: 'ack', id: message.id, bytes: message.chunk.byteLength });
      return;
    }
    case 'capture.request_end':
      await finishRequestCapture(requireCapture(message.id));
      return;
    case 'capture.response_start':
      await startResponseCapture(requireCapture(message.id), message.status, message.headers, message.streaming);
      return;
    case 'capture.response_chunk': {
      const state = requireCapture(message.id);
      if (!state.truncated) {
        const chunk = Buffer.from(message.chunk);
        state.responseText += state.responseDecoder.decode(chunk, { stream: true });
        await publishLiveSnapshot(state);
      }
      send({ type: 'ack', id: message.id, bytes: message.chunk.byteLength });
      return;
    }
    case 'capture.complete':
      await completeCapture(requireCapture(message.id));
      captures.delete(message.id);
      return;
    case 'capture.failed':
      await failCapture(requireCapture(message.id), message.status, message.error);
      captures.delete(message.id);
      return;
    case 'capture.truncated': {
      const state = captures.get(message.id);
      if (state) state.truncated = true;
      return;
    }
    case 'rpc':
      await handleRpc(message.correlationId, message.method, message.args);
      return;
    case 'shutdown':
      shuttingDown = true;
      await shutdown();
      return;
  }
}

async function finishRequestCapture(state: CaptureState): Promise<void> {
  if (state.requestBody !== undefined || state.requestDecodeError) return;
  const { decodeRequestBody } = require('../body-decode') as typeof import('../body-decode');
  const rawBody = Buffer.concat(state.requestChunks);
  const decoded = decodeRequestBody(rawBody, state.metadata.contentEncoding);
  state.requestBody = decoded.parsed;
  state.requestDecodeError = decoded.error;
  if (decoded.error) {
    console.warn(`[recorder-worker] 请求体解码失败: id=${state.metadata.id}, ${decoded.error}`);
  }
  if (decoded.parsed !== undefined) await backfillToolResults(decoded.parsed, state.metadata.apiEndpoint);
}

async function startResponseCapture(
  state: CaptureState,
  status: number,
  headers: Record<string, string>,
  streaming: boolean,
): Promise<void> {
  await finishRequestCapture(state);
  state.responseStatus = status;
  state.responseHeaders = headers;
  state.streaming = streaming;
  state.record = buildRecord(state, 'streaming');
  const { upsertRecord } = require('../store') as typeof import('../store');
  await upsertRecord(state.record);
}

async function publishLiveSnapshot(state: CaptureState): Promise<void> {
  if (!state.streaming || !state.record) return;
  const now = Date.now();
  if (now - state.lastPublishedAt < 200) return;
  state.record.streamText = state.responseText;
  state.record.durationMs = now - state.metadata.startedAt;
  const { publishStreamingRecord } = require('../store') as typeof import('../store');
  publishStreamingRecord(state.record);
  state.lastPublishedAt = now;
}

async function completeCapture(state: CaptureState): Promise<void> {
  await finishRequestCapture(state);
  state.responseText += state.responseDecoder.decode();
  if (!state.record) throw new Error(`响应完成前缺少 response_start: id=${state.metadata.id}`);
  const responseContent = await buildResponseContent(state);
  state.record.responseContent = responseContent;
  state.record.responseBody = state.responseText;
  state.record.responseHeaders = state.responseHeaders;
  state.record.responseStatus = state.responseStatus ?? 0;
  state.record.durationMs = Date.now() - state.metadata.startedAt;
  state.record.streaming = state.streaming;
  state.record.state = state.truncated ? 'error' : 'done';
  state.record.finished = state.truncated ? 'capture_truncated' : 'ok';
  state.record.error = state.truncated ? '检查数据因 Recorder 积压被截断' : undefined;
  delete state.record.streamText;

  const { computeTokenBreakdown } = require('../token-counter') as typeof import('../token-counter');
  const { serializeApiUsage } = require('../api-usage') as typeof import('../api-usage');
  state.record.tokenBreakdown = await computeTokenBreakdown(
    state.requestBody,
    responseContent,
    state.metadata.apiEndpoint,
  ) ?? undefined;
  state.record.apiUsage = serializeApiUsage(responseContent);

  const { upsertRecord, writeToolCalls } = require('../store') as typeof import('../store');
  await writeToolCalls(state.metadata.id, await extractToolCallEntries(responseContent, state.metadata.apiEndpoint));
  await upsertRecord(state.record);
}

async function failCapture(state: CaptureState, status: number, error: string): Promise<void> {
  await finishRequestCapture(state);
  state.responseText += state.responseDecoder.decode();
  const record = state.record ?? buildRecord(state, 'streaming');
  record.responseStatus = status;
  record.responseHeaders = state.responseHeaders;
  record.responseBody = state.responseText || undefined;
  record.durationMs = Date.now() - state.metadata.startedAt;
  record.state = 'error';
  record.finished = 'error';
  record.error = error;
  delete record.streamText;
  const { upsertRecord } = require('../store') as typeof import('../store');
  await upsertRecord(record);
}

function buildRecord(state: CaptureState, stateName: 'streaming' | 'done'): RecordedRequest {
  const metadata = state.metadata;
  return {
    id: metadata.id,
    timestamp: metadata.timestamp,
    method: metadata.method,
    path: metadata.path,
    upstreamUrl: metadata.upstreamUrl,
    requestHeaders: metadata.requestHeaders,
    requestBody: state.requestBody ?? null,
    responseHeaders: state.responseHeaders,
    responseStatus: state.responseStatus ?? 0,
    responseContent: null,
    streaming: state.streaming,
    durationMs: Date.now() - metadata.startedAt,
    apiType: metadata.apiType,
    apiEndpoint: metadata.apiEndpoint,
    state: stateName,
    finished: stateName === 'streaming' ? 'pending' : 'ok',
    sessionId: metadata.sessionId,
    sessionIdKey: metadata.sessionIdKey,
  };
}

async function buildResponseContent(state: CaptureState): Promise<MergedContent | null> {
  if (state.truncated) return null;
  if (state.streaming) {
    const { parseSSE, mergeChunks } = require('../sse-merger') as typeof import('../sse-merger');
    return mergeChunks(parseSSE(state.responseText), state.metadata.apiEndpoint);
  }
  try {
    return JSON.parse(state.responseText) as MergedContent;
  } catch (error) {
    console.warn(`[recorder-worker] 非流式响应 JSON 解析失败: id=${state.metadata.id}, ${formatErrorChain(error)}`);
    return null;
  }
}

async function backfillToolResults(requestBody: unknown, endpoint: CaptureMetadata['apiEndpoint']): Promise<void> {
  const { extractToolOutputs } = require('../tool-calls') as typeof import('../tool-calls');
  const { updateToolCallResults } = require('../store') as typeof import('../store');
  const updates = extractToolOutputs(requestBody, endpoint)
    .map(output => ({ tool_call_id: output.callId, result: output.result }));
  if (updates.length > 0) await updateToolCallResults(updates);
}

async function extractToolCallEntries(response: MergedContent | null, endpoint: CaptureMetadata['apiEndpoint']) {
  const { extractToolCalls } = require('../tool-calls') as typeof import('../tool-calls');
  return extractToolCalls(response, endpoint).map(candidate => ({
    tool_call_id: candidate.callId,
    tool_name: candidate.name,
    arguments: candidate.arguments,
  }));
}

async function handleRpc(correlationId: number, method: RecorderRpcMethod, args: unknown[]): Promise<void> {
  try {
    const store = require('../store') as typeof import('../store');
    let value: unknown;
    switch (method) {
      case 'requests.list':
        value = await store.getAll(
          args[0] as number | undefined,
          args[1] as number | undefined,
          args[2] as Parameters<typeof store.getAll>[2],
          args[3] as string | undefined,
        );
        break;
      case 'requests.detail':
        value = await store.getById(String(args[0]));
        break;
      case 'requests.prev': {
        const current = await store.getById(String(args[0]));
        value = current?.sessionId
          ? await store.getPrevInSession(current.id, current.sessionId)
          : null;
        break;
      }
      case 'requests.next': {
        const current = await store.getById(String(args[0]));
        value = current?.sessionId
          ? await store.getNextInSession(current.id, current.sessionId)
          : null;
        break;
      }
      case 'requests.stats':
        value = await store.getStats();
        break;
      case 'requests.neighbors':
        value = await store.getGlobalNeighbors(String(args[0]));
        break;
      case 'tools.list':
        value = { toolCalls: await store.getToolCalls(String(args[0])) };
        break;
      case 'tools.pair':
        value = await store.getToolCallPair(String(args[0]), String(args[1]));
        break;
      case 'tokenize': {
        const { resolveTokenizer } = require('../token-registry') as typeof import('../token-registry');
        const tokenizer = await resolveTokenizer(String(args[1]));
        value = { count: tokenizer ? tokenizer.encoder(String(args[0])) : 0, source: tokenizer?.source ?? null };
        break;
      }
    }
    send({ type: 'rpc.result', correlationId, ok: true, value });
  } catch (error) {
    const detail = formatErrorChain(error);
    console.error(`[recorder-worker] RPC ${method} 失败: ${detail}`);
    send({ type: 'rpc.result', correlationId, ok: false, error: detail });
  }
}

async function shutdown(): Promise<void> {
  if (!shuttingDown) return;
  const { AppDataSource } = require('../db') as typeof import('../db');
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  parentPort!.close();
}

function requireCapture(id: string): CaptureState {
  const state = captures.get(id);
  if (!state) throw new Error(`Recorder capture 不存在: id=${id}`);
  return state;
}

function send(message: RecorderToMainMessage): void {
  parentPort!.postMessage(message);
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
