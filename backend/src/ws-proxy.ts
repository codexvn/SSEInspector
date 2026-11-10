/**
 * WebSocket 升级接管与透明桥接（主线程数据面）。
 *
 * 职责边界：本模块只做传输层工作——升级请求路由、剥离逐跳压缩扩展、
 * 调用 httpxy 的 proxyUpgrade 建立双向管道、把两个方向的原始字节被动
 * tee 给 Recorder（与 HTTP 数据面的 body tee 完全对称）。帧解析、信封
 * 拆解与 lane 记录全部在 Recorder Worker 内完成（见 ws-capture.ts），
 * 主线程不解析任何 JSON/SSE（AGENTS.md 代理数据面红线第 3 条）。
 *
 * 与 Vite HMR 的共存：开发模式下 Vite 会在同一 http.Server 上监听
 * 'upgrade'（只处理 vite-hmr / vite-ping 子协议且路径等于 base），因此
 * 未命中注册表的升级请求必须原样让位（直接 return，不碰 socket）；
 * 生产模式没有其他监听者，而 Node 在存在任意 upgrade 监听后不再自动
 * 销毁连接，必须显式 destroy 以维持默认行为。
 */
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { config } from './config';
import { findWsEndpointDefinition, type EndpointDefinition } from './endpoints';
import { beginWsCapture, endWsCapture, wsCaptureChunk } from './recorder/client';
import type { WsCaptureCloseReason } from './recorder/protocol';
import { extractSessionId, filterHeaders, flattenHeaders } from './proxy';
import { getLogger, serializeError } from './logger';

const logger = getLogger('ws-proxy');

export interface UpgradeHandlerOptions {
  /** 开发模式下存在 Vite HMR 的 upgrade 监听，未命中路径必须让位 */
  isDev: boolean;
}

/** 创建 http.Server 'upgrade' 事件处理器；命中注册表走 WS 桥接，否则按模式让位或销毁 */
export function createUpgradeHandler(options: UpgradeHandlerOptions) {
  return function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      // 无法解析的 url 按未注册路径处理
    }
    const definition = findWsEndpointDefinition(pathname);
    if (!definition) {
      if (!options.isDev) socket.destroy();
      return;
    }
    bridge(definition, req, socket, head, pathname).catch(error => {
      logger.error({ path: pathname, err: serializeError(error) }, 'ws bridge failed');
      // 拨号失败时 httpxy 可能已回写错误响应；兜底销毁避免悬挂半开连接
      socket.destroy();
    });
  };
}

async function bridge(
  definition: EndpointDefinition,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  pathname: string,
): Promise<void> {
  const upstreamUrl = config.upstreamUrl;
  if (!upstreamUrl) {
    socket.destroy();
    return;
  }
  const origin = new URL(upstreamUrl).origin;
  const id = crypto.randomUUID();
  const startedAt = Date.now();
  const target = `${origin}${pathname}`;
  const session = extractSessionId(req);
  // permessage-deflate 是逐跳扩展：入口剥离请求头，两个方向帧均不压缩，
  // Recorder 的帧解析器因此无需维护 inflate 上下文（代理逐跳重协商合法）
  delete req.headers['sec-websocket-extensions'];

  logger.info({ requestId: id, method: 'WS', path: pathname, target }, 'ws connection started');
  beginWsCapture({
    id,
    startedAt,
    timestamp: new Date().toISOString(),
    method: 'WS',
    path: pathname,
    upstreamUrl: target,
    requestHeaders: flattenHeaders(filterHeaders(req.headers)),
    apiType: definition.provider,
    apiEndpoint: definition.endpoint,
    sessionId: session?.value,
    sessionIdKey: session?.key,
  });

  let finished = false;
  const finish = (reason: WsCaptureCloseReason, error?: string): void => {
    if (finished) return;
    finished = true;
    endWsCapture(id, reason, error);
    const fields = { requestId: id, status: 101, durationMs: Date.now() - startedAt, reason };
    if (reason === 'downstream_closed') logger.info(fields, 'ws connection ended');
    else logger.warn({ ...fields, err: error }, 'ws connection ended');
  };

  // 生命周期监听先挂（不触发数据流动）。WS 是全双工协议，不存在合法半关闭：
  // 收到 FIN（end）或 RST（close/error）都视为该侧离开，先到者定原因。
  // 字节 tee 必须等 proxyUpgrade resolve 之后再挂——此前两个 socket 都没有
  // 消费者、处于暂停态，早期字节安全缓存在流内部，pipe 建立后与 tee 同步
  // 流出。反之，若在拨号前就挂 data 监听，会立刻把流切到 flowing 模式：
  // pipe 建立前到达的帧被 tee 独占消费，转发路径将永久丢失这些字节。
  socket.once('close', () => finish('downstream_closed'));
  socket.once('end', () => finish('downstream_closed'));
  socket.once('error', error => finish('downstream_closed', error.message));

  const { proxyUpgrade } = await import('httpxy');
  const proxySocket = await proxyUpgrade(origin, req, socket, head, { changeOrigin: true, xfwd: false });
  socket.on('data', chunk => wsCaptureChunk(id, 'request', chunk));
  proxySocket.on('data', chunk => wsCaptureChunk(id, 'response', chunk));
  proxySocket.once('close', () => finish('upstream_closed'));
  proxySocket.once('end', () => finish('upstream_closed'));
  proxySocket.once('error', error => finish('upstream_error', error.message));
}
