import { Request, Response } from 'express';
import crypto from 'crypto';
import http, { IncomingHttpHeaders } from 'http';
import https from 'https';
import { config } from './config';
import { EndpointDefinition } from './endpoints';
import {
  beginCapture,
  beginCaptureResponse,
  captureRequestChunk,
  captureResponseChunk,
  completeCapture,
  endCaptureRequest,
  failCapture,
} from './recorder/client';

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

async function forward(req: Request, res: Response, endpointDefinition?: EndpointDefinition): Promise<void> {
  const upstreamUrl = getUpstreamUrl();
  if (!upstreamUrl) {
    res.status(500).json({ error: 'UPSTREAM_URL not configured' });
    return;
  }

  const targetUrl = upstreamUrl.replace(/\/$/, '') + req.originalUrl;
  const target = new URL(targetUrl);
  const targetLog = `${target.origin}${target.pathname}`;
  const label = endpointDefinition ? 'proxy' : 'passthrough';
  console.log(`[${label}] ${req.method} ${req.path} -> ${targetLog}`);

  const id = endpointDefinition ? crypto.randomUUID() : null;
  if (id) {
    const session = extractSessionId(req);
    const contentEncoding = firstHeader(req.headers['content-encoding']);
    beginCapture({
      id,
      startedAt: Date.now(),
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

  const upstreamHeaders = filterHeaders(req.headers);
  delete upstreamHeaders.host;
  const transport = target.protocol === 'https:' ? https : http;

  await new Promise<void>((resolve) => {
    let settled = false;
    let responseStatus = 502;
    let responseCompleted = false;

    const finishError = (error: unknown, status = responseStatus) => {
      if (settled) return;
      settled = true;
      const detail = formatErrorChain(error);
      console.error(`[${label}] 转发失败: ${detail} target=${targetLog}`);
      if (id) failCapture(id, status, detail);
      if (!res.headersSent) res.status(502).json({ error: 'Upstream unreachable' });
      else if (!res.writableEnded) res.destroy(error instanceof Error ? error : new Error(detail));
      resolve();
    };

    const upstreamReq = transport.request(target, {
      method: req.method,
      headers: upstreamHeaders,
    }, upstreamRes => {
      responseStatus = upstreamRes.statusCode ?? 502;
      const responseHeaders = filterHeaders(upstreamRes.headers as IncomingHttpHeaders);
      res.statusCode = responseStatus;
      for (const [name, value] of Object.entries(responseHeaders)) res.setHeader(name, value);
      res.flushHeaders();

      const contentType = firstHeader(upstreamRes.headers['content-type']) ?? '';
      const streaming = contentType.toLowerCase().includes('text/event-stream');
      if (id) beginCaptureResponse(id, responseStatus, flattenHeaders(responseHeaders), streaming);

      void forwardResponseBody(upstreamRes, res, chunk => {
        if (id) captureResponseChunk(id, chunk);
      }).then(() => {
        if (settled) return;
        responseCompleted = true;
        settled = true;
        res.end();
        if (id) completeCapture(id);
        resolve();
      }).catch(finishError);
    });

    upstreamReq.on('error', finishError);
    req.on('aborted', () => finishError(new Error('客户端在请求上传完成前断开'), 499));
    req.on('error', finishError);
    res.on('close', () => {
      if (responseCompleted || settled || res.writableFinished) return;
      upstreamReq.destroy();
      finishError(new Error('客户端在响应完成前断开'), responseStatus === 502 ? 499 : responseStatus);
    });

    req.on('data', (value: Buffer | string) => {
      if (settled) return;
      const chunk = typeof value === 'string' ? Buffer.from(value) : value;
      const writable = upstreamReq.write(chunk);
      if (id) captureRequestChunk(id, chunk);
      if (!writable) {
        req.pause();
        upstreamReq.once('drain', () => req.resume());
      }
    });
    req.on('end', () => {
      if (settled) return;
      if (id) endCaptureRequest(id);
      upstreamReq.end();
    });
  });
}

async function forwardResponseBody(
  upstreamRes: http.IncomingMessage,
  res: Response,
  capture: (chunk: Buffer) => void,
): Promise<void> {
  for await (const value of upstreamRes) {
    const chunk = typeof value === 'string' ? Buffer.from(value) : value;
    const writable = res.write(chunk);
    capture(chunk);
    if (!writable) await waitForDrain(res);
  }
}

function waitForDrain(res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('客户端在响应背压期间断开')); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
  });
}

function flattenHeaders(headers: ForwardHeaders): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value]),
  );
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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
