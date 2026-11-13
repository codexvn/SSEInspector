import { parentPort, workerData } from 'worker_threads';
import { TextDecoder } from 'util';
import fs from 'node:fs';
import path from 'node:path';
import { config, setConfig } from '../config';
import { isPassthroughEndpoint } from '../record-identity';
import { MainToRecorderMessage, RecorderRpcMethod, RecorderToMainMessage, CaptureMetadata } from './protocol';
import { createWsConnectionCapture, type WsConnectionCapture } from './ws-capture';
import { RecordedRequest, MergedContent } from '../types';
import { formatErrorChain, getLogger, serializeError } from '../logger';

if (!parentPort) throw new Error('Recorder Worker 缺少 parentPort');
setConfig(workerData.config);
const logger = getLogger('recorder-worker');

interface CaptureState {
  metadata: CaptureMetadata;
  requestChunks: Buffer[];
  responseDecoder: TextDecoder;
  responseText: string;
  requestBody?: unknown;
  requestDecodeError?: string;
  requestEnded: boolean;
  responseHeaders?: Record<string, string>;
  responseStatus?: number;
  streaming: boolean;
  record?: RecordedRequest;
  lastPublishedAt: number;
  /** WebSocket turn 专属：原始信封 NDJSON 累积，持久化时优先作为 response_body；HTTP 路径恒为空 */
  rawResponseText?: string;
}

const captures = new Map<string, CaptureState>();
/** WS 连接级 capture 状态（lane 管理器持有 turn 明细，与 HTTP 的 captures 分离） */
const wsConnections = new Map<string, WsConnectionCapture>();
const activeUiStates = new Map<string, RecordedRequest['state']>();
let shuttingDown = false;
let messageChain = Promise.resolve();

void initialize().catch(error => {
  const detail = formatErrorChain(error);
  logger.fatal({ err: serializeError(error) }, 'Recorder Worker initialization failed');
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
  parentPort!.on('message', enqueueMessage);
  send({ type: 'ready' });
}

/**
 * 把消息追加到串行处理链尾部。真实消息（parentPort）与 WS lane 管理器合成的
 * capture.* 消息走同一条链，保证合成消息与 ws_close 等真实消息的相对顺序。
 */
function enqueueMessage(message: MainToRecorderMessage): void {
  messageChain = messageChain
    .then(() => handleMessage(message))
    .catch(error => {
      const detail = formatErrorChain(error);
      logger.fatal({ err: serializeError(error) }, 'Recorder Worker message handling failed');
      send({ type: 'fatal', error: detail });
      process.exit(1);
    });
}

async function handleMessage(message: MainToRecorderMessage): Promise<void> {
  switch (message.type) {
    case 'capture.start':
      captures.set(message.metadata.id, {
        metadata: message.metadata,
        requestChunks: [],
        requestEnded: false,
        responseDecoder: new TextDecoder('utf-8'),
        responseText: '',
        streaming: false,
        lastPublishedAt: 0,
      });
      return;
    case 'capture.request_chunk': {
      const state = captures.get(message.id);
      if (state) state.requestChunks.push(Buffer.from(message.chunk));
      send({ type: 'ack', id: message.id, bytes: message.chunk.byteLength });
      return;
    }
    case 'capture.request_end': {
      const state = requireCapture(message.id);
      state.requestEnded = true;
      await finishRequestCapture(state);
      // 请求体接收完成即入库（status=0，读取侧派生为 pending/等待响应）：
      // 列表在首包到达前就能看到记录，不必等上游响应。上游可能早于请求体
      // 结束就回包（早响应场景），此时响应阶段已接管落库，跳过避免状态回退
      if (!state.streaming && state.responseStatus === undefined) {
        state.record = buildRecord(state, 'pending');
        const { upsertRecord } = require('../store') as typeof import('../store');
        await upsertRecord(state.record);
      }
      return;
    }
    case 'capture.response_start':
      await startResponseCapture(requireCapture(message.id), message.status, message.headers, message.streaming);
      return;
    case 'capture.response_chunk': {
      const state = requireCapture(message.id);
      const chunk = Buffer.from(message.chunk);
      state.responseText += state.responseDecoder.decode(chunk, { stream: true });
      await publishLiveSnapshot(state);
      send({ type: 'ack', id: message.id, bytes: message.chunk.byteLength });
      return;
    }
    case 'capture.complete':
      await completeCapture(requireCapture(message.id));
      captures.delete(message.id);
      return;
    case 'capture.closed':
      await closeCapture(requireCapture(message.id), message.status, message.reason);
      captures.delete(message.id);
      return;
    case 'capture.failed':
      await failCapture(requireCapture(message.id), message.status, message.error);
      captures.delete(message.id);
      return;
    case 'capture.ws_open':
      wsConnections.set(message.metadata.id, createWsConnectionCapture(message.metadata, {
        dispatch: enqueueMessage,
        appendRawResponseText(turnId, line) {
          const state = captures.get(turnId);
          if (state) state.rawResponseText = (state.rawResponseText ?? '') + line;
        },
        warn: (event, text) => logger.warn(event, text),
      }));
      return;
    case 'capture.ws_chunk': {
      const connection = wsConnections.get(message.id);
      if (connection) {
        connection.feed(message.dir, message.chunk);
      } else {
        // ws_close 后仍可能到达的迟到 chunk 属预期竞态；debug 留痕便于排查录制缺尾
        logger.debug({ id: message.id, dir: message.dir, bytes: message.chunk.byteLength }, 'ws chunk for unknown connection dropped');
      }
      send({ type: 'ack', id: message.id, bytes: message.chunk.byteLength });
      return;
    }
    case 'capture.ws_close': {
      const connection = wsConnections.get(message.id);
      if (connection) {
        connection.close(message.reason, message.error);
        wsConnections.delete(message.id);
      }
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
  if (!state.requestEnded) return;
  if (state.requestBody !== undefined || state.requestDecodeError) return;
  const { decodeRequestBody } = require('../body-decode') as typeof import('../body-decode');
  const rawBody = Buffer.concat(state.requestChunks);
  const decoded = decodeRequestBody(rawBody, state.metadata.contentEncoding);
  state.requestBody = decoded.parsed;
  state.requestDecodeError = decoded.error;
  if (decoded.error) {
    logger.warn({ requestId: state.metadata.id, detail: decoded.error }, 'captured request body decoding failed');
  }
  if (
    decoded.parsed !== undefined
    && !isPassthroughEndpoint(state.metadata.apiEndpoint)
  ) {
    await backfillToolResults(decoded.parsed, state.metadata.apiEndpoint);
  }
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
  await persistCompletedCapture(state, 'ok');
}

async function closeCapture(
  state: CaptureState,
  status: number,
  reason: 'downstream_closed' | 'request_aborted',
): Promise<void> {
  state.responseStatus ??= status;
  if (reason === 'request_aborted') {
    await persistAbortedCapture(state, status);
    return;
  }

  finishResponseText(state);
  if (isPassthroughEndpoint(state.metadata.apiEndpoint)) {
    // 透传不做 terminal SSE 判断；有 response_start 则记为完成，否则 partial
    if (state.record) {
      await persistCompletedCapture(state, 'client_close');
      return;
    }
    await persistPartialCapture(state, status, '客户端在响应完成前断开');
    return;
  }

  if (state.streaming && isTerminalCapture(state)) {
    await persistCompletedCapture(state, 'client_close');
    return;
  }

  await persistPartialCapture(state, status, '客户端在响应完成前断开');
}

async function persistCompletedCapture(state: CaptureState, finished: 'ok' | 'client_close'): Promise<void> {
  await finishRequestCapture(state);
  finishResponseText(state);
  if (!state.record) throw new Error(`响应完成前缺少 response_start: id=${state.metadata.id}`);
  const responseContent = await buildResponseContent(state);
  state.record.responseContent = responseContent;
  state.record.responseBody = state.rawResponseText ?? state.responseText;
  // 响应字符数：速度兜底指标（usage 输出 token 缺失时按字符/秒估算）
  state.record.responseChars = (state.rawResponseText ?? state.responseText).length;
  state.record.responseHeaders = state.responseHeaders;
  state.record.responseStatus = state.responseStatus ?? 0;
  state.record.durationMs = Date.now() - state.metadata.startedAt;
  state.record.streaming = state.streaming;
  state.record.state = 'done';
  state.record.finished = finished;
  delete state.record.streamText;

  if (isPassthroughEndpoint(state.metadata.apiEndpoint)) {
    state.record.apiUsage = undefined;
    const { upsertRecord } = require('../store') as typeof import('../store');
    await upsertRecord(state.record);
    return;
  }

  const { serializeApiUsage } = require('../api-usage') as typeof import('../api-usage');
  state.record.apiUsage = serializeApiUsage(responseContent);

  const { upsertRecord, writeToolCalls } = require('../store') as typeof import('../store');
  await writeToolCalls(state.metadata.id, await extractToolCallEntries(responseContent, state.metadata.apiEndpoint));
  await upsertRecord(state.record);
}

async function persistPartialCapture(state: CaptureState, status: number, error: string): Promise<void> {
  await finishRequestCapture(state);
  finishResponseText(state);
  const record = state.record ?? buildRecord(state, 'streaming');
  const responseContent = await buildResponseContent(state);
  record.responseStatus = status;
  record.responseHeaders = state.responseHeaders;
  record.responseBody = (state.rawResponseText ?? state.responseText) || undefined;
  record.responseChars = (state.rawResponseText ?? state.responseText).length;
  record.responseContent = responseContent;
  record.durationMs = Date.now() - state.metadata.startedAt;
  record.state = 'error';
  record.finished = 'client_close';
  record.error = error;
  if (!isPassthroughEndpoint(state.metadata.apiEndpoint)) {
    logger.warn({
      requestId: state.metadata.id,
      status,
      durationMs: record.durationMs,
      reason: 'downstream_closed',
    }, 'captured response is incomplete');
  }
  delete record.streamText;
  if (isPassthroughEndpoint(state.metadata.apiEndpoint)) {
    record.apiUsage = undefined;
    const { upsertRecord } = require('../store') as typeof import('../store');
    await upsertRecord(record);
    return;
  }
  const { serializeApiUsage } = require('../api-usage') as typeof import('../api-usage');
  record.apiUsage = serializeApiUsage(responseContent);
  const { upsertRecord, writeToolCalls } = require('../store') as typeof import('../store');
  await writeToolCalls(state.metadata.id, await extractToolCallEntries(responseContent, state.metadata.apiEndpoint));
  await upsertRecord(record);
}

async function persistAbortedCapture(state: CaptureState, status: number): Promise<void> {
  finishResponseText(state);
  const record = state.record ?? buildRecord(state, 'streaming');
  record.responseStatus = status;
  record.responseHeaders = state.responseHeaders;
  record.responseBody = (state.rawResponseText ?? state.responseText) || undefined;
  record.responseChars = (state.rawResponseText ?? state.responseText).length;
  record.responseContent = null;
  record.durationMs = Date.now() - state.metadata.startedAt;
  record.state = 'error';
  record.finished = 'client_close';
  record.error = '客户端在请求上传完成前断开';
  delete record.streamText;
  const { upsertRecord } = require('../store') as typeof import('../store');
  await upsertRecord(record);
}

async function failCapture(state: CaptureState, status: number, error: string): Promise<void> {
  await finishRequestCapture(state);
  finishResponseText(state);
  const record = state.record ?? buildRecord(state, 'streaming');
  record.responseStatus = status;
  record.responseHeaders = state.responseHeaders;
  record.responseBody = (state.rawResponseText ?? state.responseText) || undefined;
  record.responseChars = (state.rawResponseText ?? state.responseText).length;
  record.durationMs = Date.now() - state.metadata.startedAt;
  record.state = 'error';
  record.finished = 'error';
  record.error = error;
  delete record.streamText;
  const { upsertRecord } = require('../store') as typeof import('../store');
  await upsertRecord(record);
}

function finishResponseText(state: CaptureState): void {
  state.responseText += state.responseDecoder.decode();
}

function isTerminalCapture(state: CaptureState): boolean {
  const { isTerminalSSE, parseSSEWithMetadata } = require('../sse-merger') as typeof import('../sse-merger');
  return isTerminalSSE(parseSSEWithMetadata(state.responseText), state.metadata.apiEndpoint);
}

/**
 * 从 capture 状态构造持久化记录。stateName 为落库时的生命周期标记：
 * pending（请求已发出待响应）/ streaming（响应已开始）/ done（完成）。
 * DB 无 state 列，读取侧由 deriveState 按 finished+error+status 派生。
 */
function buildRecord(state: CaptureState, stateName: 'pending' | 'streaming' | 'done'): RecordedRequest {
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
    finished: stateName === 'done' ? 'ok' : 'pending',
    sessionId: metadata.sessionId,
    sessionIdKey: metadata.sessionIdKey,
    streamId: metadata.streamId,
  };
}

async function buildResponseContent(state: CaptureState): Promise<MergedContent | null> {
  if (isPassthroughEndpoint(state.metadata.apiEndpoint)) {
    if (state.streaming) return null;
    try {
      return JSON.parse(state.responseText) as MergedContent;
    } catch {
      return null;
    }
  }
  if (state.streaming) {
    const { parseSSE, mergeChunks } = require('../sse-merger') as typeof import('../sse-merger');
    return mergeChunks(parseSSE(state.responseText), state.metadata.apiEndpoint);
  }
  try {
    return JSON.parse(state.responseText) as MergedContent;
  } catch (error) {
    logger.warn({ requestId: state.metadata.id, err: serializeError(error) }, 'non-streaming response JSON parsing failed');
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

/**
 * 流式写出归档文件：逐行 JSON.stringify 后带背压写入，避免把整批记录
 * 拼成单个字符串的内存峰值（单行可达 MB 级）。写出失败时销毁流并抛出，
 * 由调用方兜底（归档失败即中止本轮删除，宁可下轮重试也不丢数据）。
 */
async function writeArchiveFile(
  filePath: string,
  data: { triggerCount: number; keepCount: number; requests: unknown[]; toolCalls: unknown[] },
): Promise<void> {
  const stream = fs.createWriteStream(filePath);
  // 显式 encoding 让 write(chunk, encoding, cb) 三参重载命中，避免回调被误判为 encoding
  const write = (chunk: string) => new Promise<void>((resolve, reject) => {
    stream.write(chunk, 'utf8', (error: Error | null | undefined) => (error ? reject(error) : resolve()));
  });
  try {
    await write(`{"archivedAt":${JSON.stringify(new Date().toISOString())},"triggerCount":${data.triggerCount},"keepCount":${data.keepCount},"requests":[`);
    for (let i = 0; i < data.requests.length; i++) {
      await write(i === 0 ? JSON.stringify(data.requests[i]) : `,${JSON.stringify(data.requests[i])}`);
    }
    await write('],"toolCalls":[');
    for (let i = 0; i < data.toolCalls.length; i++) {
      await write(i === 0 ? JSON.stringify(data.toolCalls[i]) : `,${JSON.stringify(data.toolCalls[i])}`);
    }
    await write(']}');
    await new Promise<void>((resolve, reject) => stream.end((error: Error | null | undefined) => (error ? reject(error) : resolve())));
  } catch (error) {
    stream.destroy();
    throw error;
  }
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
      case 'retention.run': {
        // 配置由主线程保存，执行前强制重读文件，避免用到启动时的旧值。
        // 单次最多处理 RETENTION_ROTATE_BATCH_LIMIT 条：大批量首次清理
        // 分多轮探查消化，导出用流式逐行写出，避免单串内存峰值与长时间
        // 阻塞 Worker 消息链
        const { getRetentionConfigFresh, shouldRotate, RETENTION_ROTATE_BATCH_LIMIT, retentionArchiveDir, buildArchiveFileName } =
          require('../retention') as typeof import('../retention');
        const conf = getRetentionConfigFresh();
        const total = await store.countRequests();
        const decision = shouldRotate(total, conf);
        if (!decision.rotate || decision.toDelete <= 0) {
          value = { rotated: false, enabled: conf.enabled, total };
          break;
        }
        const toDelete = Math.min(decision.toDelete, RETENTION_ROTATE_BATCH_LIMIT);
        const { requests: oldest, toolCalls } = await store.getOldestRequests(toDelete);
        const archiveDir = retentionArchiveDir();
        fs.mkdirSync(archiveDir, { recursive: true });
        const fileName = buildArchiveFileName(new Date());
        await writeArchiveFile(path.join(archiveDir, fileName), {
          triggerCount: conf.triggerCount,
          keepCount: conf.keepCount,
          requests: oldest,
          toolCalls,
        });
        const deleted = await store.deleteRequests(oldest.map(row => row.id));
        logger.info({ deleted, archivedFile: fileName, total: total - deleted }, 'retention rotated');
        value = { rotated: true, deleted, archivedFile: fileName, total: total - deleted };
        break;
      }
      case 'retention.archives': {
        const { retentionArchiveDir, ARCHIVE_FILE_PATTERN } = require('../retention') as typeof import('../retention');
        const archiveDir = retentionArchiveDir();
        value = fs.existsSync(archiveDir)
          ? fs.readdirSync(archiveDir)
            .filter(name => ARCHIVE_FILE_PATTERN.test(name))
            .map(name => {
              const stat = fs.statSync(path.join(archiveDir, name));
              return { name, size: stat.size, modifiedAt: stat.mtime.toISOString() };
            })
            .sort((a, b) => b.name.localeCompare(a.name))
          : [];
        break;
      }
      case 'requests.neighbors':
        value = await store.getGlobalNeighbors(String(args[0]));
        break;
      case 'tools.list':
        value = { toolCalls: await store.getToolCalls(String(args[0])) };
        break;
      case 'tools.pair':
        value = await store.getToolCallPair(String(args[0]), String(args[1]));
        break;
    }
    send({ type: 'rpc.result', correlationId, ok: true, value });
  } catch (error) {
    const detail = formatErrorChain(error);
    logger.error({ method, err: serializeError(error) }, 'Recorder Worker RPC failed');
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
