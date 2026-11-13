/**
 * Responses WebSocket 连接的 lane 录制管理器（运行于 Recorder Worker）。
 *
 * 职责：把一条 WS 连接的双向字节流（主线程只做 tee，见 ws-proxy.ts）解析成帧，
 * 再把每个 `response.create` 生命周期（一个 turn）翻译成合成的 capture.* 消息，
 * 经 Worker 的消息链串行分发——从而完整复用既有的请求解码、流式发布、
 * SSE 合并、终态判定与持久化管线，worker 的 HTTP 路径零改动。
 *
 * 关键约定：
 * - 记录单位是 turn（一次 response.create → 终态），stream_id 是 lane 维度；
 *   同一 stream_id 顺序发起多个 turn 会产生多条记录（与多条 HTTP 请求同构）。
 * - server 信封 `{"type":"message","stream_id":...,"message":{...}}` 的内层事件
 *   序列化为 `data: {json}\n\n` 追加进 turn 的 responseText，使 live 推送、
 *   parseSSE 合并、isTerminal 终态判断三条现有路径全部无改动生效；
 *   原始信封以 NDJSON 行累积到 rawResponseText，落库为 response_body。
 * - 所有外部输入（帧、JSON、信封结构）做防御性解析：坏数据只 warn 不抛，
 *   因为 Worker 消息链内抛错等于整个 Recorder 退出。
 */

import {
  createWebSocketFrameParser,
  WS_OPCODE_TEXT,
  type WsFrame,
} from './ws-frames';
import type { CaptureMetadata, MainToRecorderMessage, WsCaptureCloseReason } from './protocol';

/** 内层事件的终态类型集合；与 SSE 侧 isTerminalSSE 的 openai-responses 分支保持一致 */
const TURN_TERMINAL_INNER_TYPES = new Set(['response.completed', 'response.failed', 'response.incomplete']);

export interface WsCaptureHooks {
  /** 把合成消息追加到 Worker 消息链尾部（与真实消息串行，避免重入破坏顺序） */
  dispatch(message: MainToRecorderMessage): void;
  /** 向 turn 的 CaptureState 追加原始信封行（持久化时作为 response_body） */
  appendRawResponseText(turnId: string, line: string): void;
  /** 结构化告警（沿用 Worker 的 Pino logger） */
  warn(event: Record<string, unknown>, message: string): void;
}

export interface WsConnectionCapture {
  /** 投喂一个方向的原始 socket 字节（request = 下游→上游，response = 上游→下游） */
  feed(dir: 'request' | 'response', chunk: Uint8Array): void;
  /** 连接结束：把所有未完成 turn 按来源转译为 closed / failed 后清理状态 */
  close(reason: WsCaptureCloseReason, error?: string): void;
}

interface WsTurn {
  /** stream_id；隐式默认 lane（信封不携带 stream_id）为空字符串 */
  laneId: string;
  /** 该 turn 的独立 capture id（合成记录主键） */
  turnId: string;
}

/** 原生 Responses 事件类型前缀：帧本身即内层事件（无 message 信封包装） */
function isNativeResponsesEvent(type: string): boolean {
  return type.startsWith('response.');
}

export function createWsConnectionCapture(
  metadata: CaptureMetadata,
  hooks: WsCaptureHooks,
): WsConnectionCapture {
  let turnCounter = 0;
  const turns = new Map<string, WsTurn>();
  /** 最近创建且仍在进行中的 turn：原生协议帧不带 lane 标识时的归属目标 */
  let latestTurn: WsTurn | null = null;
  // 两个方向各一个帧解析器；客户端方向帧带掩码，解析器内部统一解除
  const parsers = {
    request: createWebSocketFrameParser({
      onProtocolError: message => hooks.warn({ requestId: metadata.id, dir: 'request' }, message),
    }),
    response: createWebSocketFrameParser({
      onProtocolError: message => hooks.warn({ requestId: metadata.id, dir: 'response' }, message),
    }),
  };

  return {
    feed(dir, chunk) {
      for (const frame of parsers[dir].push(chunk)) handleFrame(dir, frame);
    },

    close(reason, error) {
      for (const turn of turns.values()) {
        if (reason === 'downstream_closed') {
          hooks.dispatch({ type: 'capture.closed', id: turn.turnId, status: 101, reason: 'downstream_closed' });
        } else {
          hooks.dispatch({
            type: 'capture.failed',
            id: turn.turnId,
            status: 502,
            error: error ?? (reason === 'upstream_error' ? '上游 WebSocket 连接错误' : '上游 WebSocket 连接关闭'),
          });
        }
      }
      turns.clear();
      latestTurn = null;
    },
  };

  function handleFrame(dir: 'request' | 'response', frame: WsFrame): void {
    // 二进制帧与控制帧不参与 lane 语义（字节层已由 httpxy 管道原样透传）
    if (frame.opcode !== WS_OPCODE_TEXT) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.payload.toString('utf8'));
    } catch {
      hooks.warn({ requestId: metadata.id, dir, bytes: frame.payload.length }, 'WS 文本帧不是合法 JSON，跳过 lane 处理');
      return;
    }
    if (!isRecord(parsed)) return;
    if (dir === 'request') handleClientEvent(parsed, frame.payload);
    else handleServerFrame(parsed);
  }

  function handleClientEvent(event: Record<string, unknown>, payload: Buffer): void {
    // response.steer 等 WS 专属客户端事件 v1 不单独记录（透传不落库）
    if (event.type !== 'response.create') return;
    const laneId = typeof event.stream_id === 'string' ? event.stream_id : '';
    const existing = turns.get(laneId);
    if (existing) {
      hooks.warn(
        { requestId: metadata.id, streamId: laneId },
        '同 stream_id 上一 turn 未结束时收到新 response.create，旧 turn 按错误收尾',
      );
      hooks.dispatch({
        type: 'capture.failed',
        id: existing.turnId,
        status: 502,
        error: '同 stream_id 在上一 turn 结束前收到新的 response.create',
      });
      if (latestTurn === existing) latestTurn = null;
    }

    const turn: WsTurn = { laneId, turnId: `${metadata.id}:${++turnCounter}` };
    turns.set(laneId, turn);
    latestTurn = turn;
    // 一个 turn 一条记录：create 事件原文作为请求体，随后立即进入 streaming 等首包状态
    hooks.dispatch({
      type: 'capture.start',
      metadata: {
        ...metadata,
        id: turn.turnId,
        startedAt: Date.now(),
        timestamp: new Date().toISOString(),
        streamId: laneId || undefined,
      },
    });
    hooks.dispatch({ type: 'capture.request_chunk', id: turn.turnId, chunk: payload });
    hooks.dispatch({ type: 'capture.request_end', id: turn.turnId });
    hooks.dispatch({ type: 'capture.response_start', id: turn.turnId, status: 101, headers: {}, streaming: true });
  }

  /**
   * 服务端帧兼容两种协议形态：
   * 1. 信封包装（CLIProxyAPI 风格网关）：{"type":"message","stream_id":..,"message":{内层事件}}；
   * 2. 原生 Responses 事件（OpenAI / 多数中转直透）：帧本身即 {"type":"response.*",...}，
   *    不携带 stream_id，按最近活跃 turn 归属。
   * 信封携带 stream_id 而客户端 create 未带时，学习该映射（重挂 lane 键）。
   */
  function handleServerFrame(frame: Record<string, unknown>): void {
    const frameLane = typeof frame.stream_id === 'string' ? frame.stream_id : '';
    const type = typeof frame.type === 'string' ? frame.type : '';

    // 请求级错误信封：原文入 raw，等价的内层 error 事件进合并管线并终结归属 turn
    if (type === 'error') {
      const turn = turns.get(frameLane) ?? latestTurn;
      if (!turn) {
        hooks.warn({ requestId: metadata.id, type }, 'WS 错误帧没有对应进行中的 turn，跳过');
        return;
      }
      hooks.appendRawResponseText(turn.turnId, `${JSON.stringify(frame)}\n`);
      emitInner(turn, { type: 'error', error: frame.error ?? null });
      finishTurn(turn);
      return;
    }

    // steer.accepted / steer.pending / steer.failed 等 WS 专属回执 v1 不进记录
    if (type.startsWith('steer.')) return;

    if (type === 'message' && isRecord(frame.message)) {
      const turn = turns.get(frameLane) ?? turns.get('');
      if (!turn) {
        hooks.warn({ requestId: metadata.id, streamId: frameLane, type }, 'WS 信封没有对应进行中的 turn，跳过');
        return;
      }
      // 信封 lane 与 turn 键不同（服务端补全的 stream_id）：学习映射并重挂键
      if (frameLane !== turn.laneId) {
        turns.delete(turn.laneId);
        turn.laneId = frameLane;
        turns.set(frameLane, turn);
      }
      const inner = frame.message;
      hooks.appendRawResponseText(turn.turnId, `${JSON.stringify(frame)}\n`);
      emitInner(turn, inner);
      if (typeof inner.type === 'string' && TURN_TERMINAL_INNER_TYPES.has(inner.type)) finishTurn(turn);
      return;
    }

    if (isNativeResponsesEvent(type)) {
      const turn = turns.get(frameLane) ?? latestTurn;
      if (!turn) {
        hooks.warn({ requestId: metadata.id, type }, '原生 Responses 事件没有对应进行中的 turn，跳过');
        return;
      }
      hooks.appendRawResponseText(turn.turnId, `${JSON.stringify(frame)}\n`);
      emitInner(turn, frame);
      if (TURN_TERMINAL_INNER_TYPES.has(type)) finishTurn(turn);
      return;
    }

    hooks.warn({ requestId: metadata.id, type: type || '(missing)' }, '未知 WS 服务端帧类型，跳过');
  }

  function emitInner(turn: WsTurn, inner: unknown): void {
    // 内层事件序列化为 SSE data 行喂给现有 responseText 管线（live/合并/终态三路复用）
    hooks.dispatch({
      type: 'capture.response_chunk',
      id: turn.turnId,
      chunk: Buffer.from(`data: ${JSON.stringify(inner)}\n\n`, 'utf8'),
    });
  }

  function finishTurn(turn: WsTurn): void {
    hooks.dispatch({ type: 'capture.complete', id: turn.turnId });
    turns.delete(turn.laneId);
    if (latestTurn === turn) latestTurn = null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
