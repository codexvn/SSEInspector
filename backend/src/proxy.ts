import { Request, Response } from 'express';
import crypto from 'crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'http';
import type { ProxyServer } from 'httpxy' with { 'resolution-mode': 'import' };
import { Transform } from 'stream';
import { config } from './config';
import { EndpointDefinition } from './endpoints';
import { formatErrorChain, getLogger, serializeError } from './logger';
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

interface ProxyContext {
  id: string | null;
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

/** 读取 CLI 写入的唯一上游 URL 配置。 */
function getUpstreamUrl(): string {
  return config.upstreamUrl;
}

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
 *  优先匹配已知列表，兜底匹配任意以 -session-id 结尾的头（忽略大小写）。 */
function extractSessionId(req: Request): { value: string; key: string } | null {
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

function filterHeaders(headers: Record<string, string | string[] | undefined>): ForwardHeaders {
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
  const upstreamUrl = getUpstreamUrl();
  if (!upstreamUrl) {
    res.status(500).json({ error: 'UPSTREAM_URL not configured' });
    return;
  }
  const proxy = await getProxyServer();

  const targetUrl = upstreamUrl.replace(/\/$/, '') + req.originalUrl;
  const target = new URL(targetUrl);
  const targetLog = `${target.origin}${target.pathname}`;
  const label = endpointDefinition ? 'proxy' : 'passthrough';
  const id = endpointDefinition ? crypto.randomUUID() : null;
  const startedAt = Date.now();
  getLogger(label).info({
    requestId: id ?? '-',
    method: req.method,
    path: req.path,
    target: targetLog,
  }, 'proxy request started');
  if (id) {
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
      apiType: endpointDefinition!.provider,
      apiEndpoint: endpointDefinition!.endpoint,
      sessionId: session?.value,
      sessionIdKey: session?.key,
    });
  }

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

  const requestTap = id ? createRequestCaptureTap(id, context) : undefined;
  context.requestTap = requestTap;
  if (requestTap) req.pipe(requestTap);
  req.once('aborted', () => {
    finalizeClosed(context, 499, 'request_aborted');
  });
  res.once('close', () => {
    if (res.writableFinished || context.finalized) return;
    context.downstreamClosed = true;
    finalizeClosed(context, context.responseStarted ? context.responseStatus : 499, 'downstream_closed');
  });

  await proxy.web(req, res, {
    target: upstreamUrl,
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
    if (context.id) {
      beginCaptureResponse(context.id, context.responseStatus, flattenHeaders(responseHeaders), streaming);
      proxyRes.on('data', (value: Buffer | string) => {
        if (!context.id || context.finalized) return;
        captureResponseChunk(context.id, typeof value === 'string' ? Buffer.from(value) : value);
      });
    }
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
    if (context.id) completeCapture(context.id);
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
  if (context.id) closeCapture(context.id, status, reason);
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
  if (context.id) failCapture(context.id, context.responseStatus, detail);
}

function contextLogFields(context: ProxyContext, status = context.responseStatus) {
  return {
    requestId: context.id ?? '-',
    status,
    durationMs: Date.now() - context.startedAt,
    target: context.targetLog,
  };
}

function flattenHeaders(headers: ForwardHeaders): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value]),
  );
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
