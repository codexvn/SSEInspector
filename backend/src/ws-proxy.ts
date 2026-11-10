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
 * 未命中注册表的 WebSocket 升级必须原样让位（直接 return，不碰 socket）；
 * 生产模式没有其他监听者，而 Node 在存在任意 upgrade 监听后不再自动
 * 销毁连接，必须显式 destroy 以维持默认行为。
 *
 * 非 WebSocket 升级的优雅拒绝：Node 只要有 upgrade 监听，任何带
 * Connection: Upgrade 的请求都会被 divert 进 upgrade 事件而不再走普通
 * 请求管线。JDK HttpClient（默认 HTTP/2）对明文 http:// 地址的每个新连接
 * 都会先发 h2c 升级尝试（Connection: Upgrade + Upgrade: h2c + HTTP2-Settings），
 * 若在此直接销毁，客户端的每个请求都会收到零字节重置。因此带升级语义
 * 但不是 WebSocket 的请求按 RFC 语义拒绝升级：剥除升级头后重建请求字节，
 * 重新走普通 HTTP/1.1 管线，客户端收到普通响应并继续在原连接上使用 1.1。
 */
import crypto from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
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
  /** 挂载本处理器的 http.Server：非 WebSocket 升级需要桥接回普通请求管线 */
  server: Server;
}

/** 判定是否为真正的 WebSocket 升级：Upgrade 令牌含 websocket 且携带握手密钥 */
function isWebSocketUpgrade(req: IncomingMessage): boolean {
  const hasToken = String(req.headers.upgrade ?? '')
    .split(',')
    .some(token => token.trim().toLowerCase() === 'websocket');
  return hasToken && req.headers['sec-websocket-key'] !== undefined;
}

/**
 * 拒绝非 WebSocket 升级并桥接回普通请求管线。
 *
 * 重建规则：请求行原样；Upgrade / HTTP2-Settings 头整体删除；Connection
 * 头剥除 upgrade / http2-settings 令牌。这三者都是逐跳头，filterHeaders
 * 转发上游时本就会剥除，因此上游收到的请求不变，仅记录中的请求头展示
 * 与原始字节有此差异。防重入护栏必须存在：若重建字节再次触发 upgrade
 * 事件（剥离逻辑失效等异常场景），销毁连接而不是继续桥接，否则会形成
 * 解析循环耗尽内存。
 */
function declineUpgrade(
  server: Server,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  bridged: WeakSet<Duplex>,
): void {
  if (bridged.has(socket)) {
    logger.warn({ path: req.url }, 'bridged socket re-entered upgrade path, destroying');
    socket.destroy();
    return;
  }
  bridged.add(socket);
  const lines = [`${req.method} ${req.url} HTTP/1.1`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    if (name === undefined || value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower === 'upgrade' || lower === 'http2-settings') continue;
    if (lower === 'connection') {
      const kept = value.split(',').map(token => token.trim()).filter(token => {
        const normalized = token.toLowerCase();
        return normalized !== 'upgrade' && normalized !== 'http2-settings';
      });
      if (kept.length === 0) continue;
      lines.push(`${name}: ${kept.join(', ')}`);
      continue;
    }
    lines.push(`${name}: ${value}`);
  }
  const rebuiltHead = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`);
  socket.unshift(Buffer.concat([rebuiltHead, head]));
  server.emit('connection', socket as unknown as Socket);
  logger.info(
    { path: req.url, upgrade: req.headers.upgrade },
    'non-websocket upgrade declined, bridged to http pipeline',
  );
}

/** 创建 http.Server 'upgrade' 事件处理器；WebSocket 升级按注册表桥接，其余升级拒绝后走普通请求管线 */
export function createUpgradeHandler(options: UpgradeHandlerOptions) {
  const bridged = new WeakSet<Duplex>();
  return function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!isWebSocketUpgrade(req)) {
      // h2c 等非 WebSocket 升级：优雅拒绝，请求继续按普通 HTTP/1.1 处理
      declineUpgrade(options.server, req, socket, head, bridged);
      return;
    }
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
