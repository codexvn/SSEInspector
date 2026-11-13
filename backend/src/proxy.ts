import { Request, Response } from 'express';
import crypto from 'crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'http';
import type { ProxyServer } from 'httpxy' with { 'resolution-mode': 'import' };
import { Transform } from 'stream';
import { EndpointDefinition } from './endpoints';
import { formatErrorChain, getLogger, serializeError } from './logger';
import { resolveUpstream } from './routing';
import {
  beginCapture,
  beginCaptureResponse,
  captureRequestChunk,
  captureResponseChunk,
  closeCapture,
  completeCapture,
  endCaptureRequest,
  failCapture,
} from './recorder/client';
import { ApiEndpoint, ApiType } from './types';

interface ProxyContext {
  id: string;
  startedAt: number;
  label: 'proxy' | 'passthrough';
  targetLog: string;
  responseStatus: number;
  responseStarted: boolean;
  downstreamClosed: boolean;
  finalized: boolean;
  requestTap?: Transform;
}

let proxyServerPromise: Promise<ProxyServer> | null = null;
const proxyContexts = new WeakMap<IncomingMessage, ProxyContext>();

const HOP_HEADERS = [
  'connection', 'keep-alive', 'transfer-encoding', 'te',
  'trailer', 'proxy-authenticate', 'proxy-authorization', 'upgrade',
];

/** 已知的 session ID 请求头（小写），按优先级排序 */
const KNOWN_SESSION_HEADERS = [
  'x-claude-code-session-id',
  'session_id',
  'x-amp-thread-id',
  'x-grok-conv-id',
  'x-session-affinity',
];

/** 从请求头中按已知列表提取 session ID，返回 { value, key } 或 null。
 *  优先匹配已知列表，兜底匹配任意以 -session-id 结尾的头（忽略大小写）。
 *  参数取结构最小类型，HTTP 与 WS 升级请求都可传入。 */
export function extractSessionId(req: { headers: Record<string, string | string[] | undefined> }): { value: string; key: string } | null {
  const headers = req.headers as Record<string, string | string[] | undefined>;
  // 第一轮：已知列表精确匹配
  for (const name of KNOWN_SESSION_HEADERS) {
    const v = headers[name];
    if (v) {
      const value = Array.isArray(v) ? v[0] : v;
      if (value) return { value, key: name };
    }
  }
  // 第二轮：兜底匹配，忽略大小写，后缀为 -session-id 即命中
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase().endsWith('session-id')) {
      const v = headers[key];
      if (v) {
        const value = Array.isArray(v) ? v[0] : v;
        if (value) return { value, key: key.toLowerCase() };
      }
    }
  }
  return null;
}

type ForwardHeaders = Record<string, string | string[]>;

export function filterHeaders(headers: Record<string, string | string[] | undefined>): ForwardHeaders {
  const result: ForwardHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_HEADERS.includes(key.toLowerCase())) continue;
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export async function handlePassthrough(req: Request, res: Response): Promise<void> {
  await forward(req, res);
}

export async function handleProxy(req: Request, res: Response, endpointDefinition: EndpointDefinition): Promise<void> {
  await forward(req, res, endpointDefinition);
}

export async function initializeProxy(): Promise<void> {
  await getProxyServer();
}

async function forward(req: Request, res: Response, endpointDefinition?: EndpointDefinition): Promise<void> {
  const label = endpointDefinition ? 'proxy' : 'passthrough';
  const id = crypto.randomUUID();
  // 分流解析：规则命中或默认上游二选一；两者皆无时明确拒绝（请求未离开本机，
  // 不产生录制记录），由调用语义保证客户端拿到可理解的错误而不是超时
  const resolved = resolveUpstream(req.path);
  if (!resolved) {
    getLogger(label).warn({ requestId: id, method: req.method, path: req.path }, 'no upstream resolved, rejecting request');
    res.status(503).json({ error: '未匹配任何分流规则且未配置默认上游' });
    return;
  }
  const proxy = await getProxyServer();

  // 规则命中时剥离被匹配的前缀（挂载点语义）：/easytier/v1/models → 上游收到
  // /v1/models；需在上游保留前缀的场景把前缀写进规则上游地址的路径即可组合
  // 还原。根前缀 / 无可剥离；query 串原样保留。默认上游不剥离。
  let outgoingUrl = req.originalUrl;
  if (resolved.source === 'route' && resolved.prefix && resolved.prefix !== '/') {
    const searchIndex = req.originalUrl.indexOf('?');
    const search = searchIndex >= 0 ? req.originalUrl.slice(searchIndex) : '';
    const stripped = req.path === resolved.prefix ? '/' : req.path.slice(resolved.prefix.length);
    outgoingUrl = stripped + search;
  }
  const targetUrl = resolved.upstream.replace(/\/$/, '') + outgoingUrl;
  const target = new URL(targetUrl);
  const targetLog = `${target.origin}${target.pathname}`;
  // 所有经 forward 的代理流量都记录（含未注册 path 的透传）
  const startedAt = Date.now();
  getLogger(label).info({
    requestId: id,
    method: req.method,
    path: req.path,
    target: targetLog,
  }, 'proxy request started');
  const session = extractSessionId(req);
  const contentEncoding = firstHeader(req.headers['content-encoding']);
  beginCapture({
    id,
    startedAt,
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.path,
    upstreamUrl: targetUrl,
    requestHeaders: flattenHeaders(filterHeaders(req.headers)),
    contentEncoding,
    apiType: endpointDefinition?.provider ?? ApiType.Passthrough,
    apiEndpoint: endpointDefinition?.endpoint ?? ApiEndpoint.Passthrough,
    sessionId: session?.value,
    sessionIdKey: session?.key,
  });

  const context: ProxyContext = {
    id,
    startedAt,
    label,
    targetLog,
    responseStatus: 502,
    responseStarted: false,
    downstreamClosed: false,
    finalized: false,
  };
  proxyContexts.set(req, context);

  const requestTap = createRequestCaptureTap(id, context);
  context.requestTap = requestTap;
  req.pipe(requestTap);

  // httpxy 以 req.url 作为出网路径：命中规则时改写为剥离前缀后的路径。
  // capture 快照已取原始 req.path，记录不受影响；upstreamUrl 元数据与
  // 实际出网路径一致
  if (resolved.source === 'route' && resolved.prefix && resolved.prefix !== '/') {
    req.url = outgoingUrl;
  }

  req.once('aborted', () => {
    finalizeClosed(context, 499, 'request_aborted');
  });
  res.once('close', () => {
    if (res.writableFinished || context.finalized) return;
    context.downstreamClosed = true;
    finalizeClosed(context, context.responseStarted ? context.responseStatus : 499, 'downstream_closed');
  });

  await proxy.web(req, res, {
    target: resolved.upstream,
    changeOrigin: true,
    xfwd: false,
    followRedirects: false,
    selfHandleResponse: false,
    proxyTimeout: 0,
    buffer: requestTap,
  });
}

function createRequestCaptureTap(id: string, context: ProxyContext): Transform {
  const tap = new Transform({
    transform(value: Buffer | string, _encoding, callback) {
      const chunk = typeof value === 'string' ? Buffer.from(value) : value;
      if (!context.finalized) captureRequestChunk(id, chunk);
      callback(null, chunk);
    },
  });
  tap.once('finish', () => {
    if (!context.finalized) endCaptureRequest(id);
  });
  return tap;
}

async function getProxyServer(): Promise<ProxyServer> {
  proxyServerPromise ??= import('httpxy').then(({ createProxyServer }) => {
    const proxy = createProxyServer({
      changeOrigin: true,
      xfwd: false,
      followRedirects: false,
      selfHandleResponse: false,
      proxyTimeout: 0,
    });
    registerProxyEvents(proxy);
    return proxy;
  });
  return proxyServerPromise;
}

function registerProxyEvents(proxy: ProxyServer): void {
  proxy.on('proxyRes', (proxyRes, req) => {
    const context = proxyContexts.get(req);
    if (!context || context.finalized) return;
    context.responseStarted = true;
    context.responseStatus = proxyRes.statusCode ?? 502;
    const responseHeaders = filterHeaders(proxyRes.headers as IncomingHttpHeaders);
    const contentType = firstHeader(proxyRes.headers['content-type']) ?? '';
    const streaming = contentType.toLowerCase().includes('text/event-stream');
    beginCaptureResponse(context.id, context.responseStatus, flattenHeaders(responseHeaders), streaming);
    proxyRes.on('data', (value: Buffer | string) => {
      if (context.finalized) return;
      captureResponseChunk(context.id, typeof value === 'string' ? Buffer.from(value) : value);
    });
    proxyRes.once('aborted', () => {
      if (!context.downstreamClosed) finalizeFailure(context, new Error('上游响应异常中断'), 'upstream_aborted');
    });
    proxyRes.once('close', () => {
      if (!proxyRes.complete && !context.downstreamClosed) {
        finalizeFailure(context, new Error('上游响应在完成前关闭'), 'upstream_aborted');
      }
    });
  });
  proxy.on('end', (req) => {
    const context = proxyContexts.get(req);
    if (!context || context.finalized) return;
    context.finalized = true;
    getLogger(context.label).info({
      ...contextLogFields(context),
      reason: 'upstream_complete',
    }, 'proxy request ended');
    completeCapture(context.id);
  });
  proxy.on('econnreset', (_error, req) => {
    const context = proxyContexts.get(req);
    if (!context || context.finalized) return;
    context.downstreamClosed = true;
    finalizeClosed(context, context.responseStarted ? context.responseStatus : 499, 'downstream_closed');
  });
  proxy.on('error', (error, req, res) => {
    const context = req ? proxyContexts.get(req) : undefined;
    if (context?.downstreamClosed) return;
    if (context) finalizeFailure(context, error, 'upstream_error');
    if (res && 'headersSent' in res && !res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Upstream unreachable' }));
    } else if (res && 'destroyed' in res && !res.destroyed) {
      res.destroy(error);
    }
  });
}

function finalizeClosed(
  context: ProxyContext,
  status: number,
  reason: 'downstream_closed' | 'request_aborted',
): void {
  if (context.finalized) return;
  context.downstreamClosed = true;
  context.finalized = true;
  context.requestTap?.destroy();
  closeCapture(context.id, status, reason);
  const logger = getLogger(context.label);
  const fields = { ...contextLogFields(context, status), reason };
  if (reason === 'request_aborted') logger.warn(fields, 'proxy request aborted');
  else logger.info(fields, 'proxy request ended');
}

function finalizeFailure(
  context: ProxyContext,
  error: unknown,
  reason: 'upstream_aborted' | 'upstream_error',
): void {
  if (context.finalized) return;
  context.finalized = true;
  context.requestTap?.destroy();
  const detail = `${reason}: ${formatErrorChain(error)}`;
  getLogger(context.label).error({
    ...contextLogFields(context),
    reason,
    err: serializeError(error),
  }, 'proxy request failed');
  failCapture(context.id, context.responseStatus, detail);
}

function contextLogFields(context: ProxyContext, status = context.responseStatus) {
  return {
    requestId: context.id,
    status,
    durationMs: Date.now() - context.startedAt,
    target: context.targetLog,
  };
}

export function flattenHeaders(headers: ForwardHeaders): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value]),
  );
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
