import { Request, Response } from 'express';
import { upsertRecord } from './store';
import { parseSSE, mergeChunks } from './sse-merger';
import { RecordedRequest, ApiType, SSEChunk, MergedContent } from './types';

const HOP_HEADERS = [
  'connection', 'keep-alive', 'transfer-encoding', 'te',
  'trailer', 'proxy-authenticate', 'proxy-authorization', 'upgrade',
];

function filterHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_HEADERS.includes(key.toLowerCase())) continue;
    if (value !== undefined) {
      result[key] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return result;
}

function baseRecord(
  id: string, req: Request, status: number, streaming: boolean, apiType: ApiType,
  startTime: number, error?: string,
): RecordedRequest {
  return {
    id,
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.path,
    requestHeaders: filterHeaders(req.headers as Record<string, string | string[] | undefined>),
    requestBody: req.body,
    responseStatus: status,
    responseContent: null,
    streaming,
    durationMs: Date.now() - startTime,
    apiType,
    error,
    state: error ? 'error' : streaming ? 'streaming' : 'done',
    chunks: [],
  };
}

export async function handleProxy(req: Request, res: Response, apiType: ApiType): Promise<void> {
  const upstreamUrl = process.env.UPSTREAM_URL;
  if (!upstreamUrl) {
    res.status(500).json({ error: 'UPSTREAM_URL not configured' });
    return;
  }

  const id = crypto.randomUUID();
  const startTime = Date.now();
  const isStreaming = (req.body as Record<string, unknown>)?.stream === true;
  const targetUrl = upstreamUrl.replace(/\/$/, '') + req.path;

  const upstreamHeaders = filterHeaders(req.headers as Record<string, string | string[] | undefined>);
  delete upstreamHeaders['host'];
  // Anthropic requires x-api-key header
  if (apiType === 'anthropic' && req.headers['x-api-key']) {
    upstreamHeaders['x-api-key'] = req.headers['x-api-key'] as string;
  }

  const fetchInit: RequestInit = {
    method: req.method,
    headers: upstreamHeaders,
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    fetchInit.body = JSON.stringify(req.body);
  }

  try {
    const upstreamRes = await fetch(targetUrl, fetchInit);
    const responseStatus = upstreamRes.status;
    const responseHeaders = filterHeaders(Object.fromEntries(upstreamRes.headers.entries()));

    res.status(responseStatus);
    for (const [key, value] of Object.entries(responseHeaders)) {
      res.setHeader(key, value);
    }

    if (!isStreaming || !upstreamRes.body) {
      // --- Non-streaming ---
      const json = await upstreamRes.json();
      res.json(json);

      const record = baseRecord(id, req, responseStatus, false, apiType, startTime);
      record.responseContent = json as MergedContent;
      record.state = 'done';
      upsertRecord(record);
    } else {
      // --- Streaming ---
      upsertRecord(baseRecord(id, req, responseStatus, true, apiType, startTime));

      const reader = upstreamRes.body.getReader();
      const rawChunks: Uint8Array[] = [];

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
          rawChunks.push(new Uint8Array(value));
        }
      } finally {
        res.end();
        try { reader.releaseLock(); } catch { /* already released */ }
      }

      // Parse SSE, merge, record
      const fullText = Buffer.concat(rawChunks).toString('utf-8');
      const chunks: SSEChunk[] = parseSSE(fullText, apiType);
      const merged = mergeChunks(chunks, apiType);

      const record = baseRecord(id, req, responseStatus, true, apiType, startTime);
      record.responseContent = merged;
      record.chunks = chunks;
      record.state = 'done';
      upsertRecord(record);
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Upstream unreachable', detail: String(err) });
    }
    upsertRecord(baseRecord(id, req, res.headersSent ? 200 : 502, isStreaming, apiType, startTime, String(err)));
  }
}
