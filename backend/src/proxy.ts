import { Request, Response } from 'express';
import { upsertRecord, writeToolCalls, updateApiUsage, ToolCallEntry } from './store';
import { parseSSE, mergeChunks } from './sse-merger';
import { computeTokenBreakdown } from './token-counter';
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
  const targetUrl = (process.env.UPSTREAM_URL ?? '').replace(/\/$/, '') + req.path;
  return {
    id,
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.path,
    upstreamUrl: targetUrl,
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

/** 从 requestBody + responseContent 提取工具调用配对 */
function extractToolCalls(
  requestBody: unknown,
  responseContent: MergedContent | null,
  apiType: ApiType,
): ToolCallEntry[] {
  // 第一步：从 requestBody 提取 tool_result（结果）
  const results = new Map<string, string>(); // tool_call_id → result
  const msgList = (requestBody as Record<string, unknown>)?.messages as Record<string, unknown>[] | undefined;
  if (msgList) {
    for (const msg of msgList) {
      if (apiType === 'openai' && msg.role === 'tool' && msg.tool_call_id) {
        const c = msg.content;
        results.set(String(msg.tool_call_id), typeof c === 'string' ? c : JSON.stringify(c));
      }
      if (apiType === 'anthropic' && Array.isArray(msg.content)) {
        for (const block of msg.content as Record<string, unknown>[]) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const c = block.content;
            results.set(String(block.tool_use_id), typeof c === 'string' ? c : JSON.stringify(c));
          }
        }
      }
    }
  }

  // 第二步：从 responseContent 提取 tool_use（请求参数），配对 result
  const entries: ToolCallEntry[] = [];
  if (apiType === 'openai') {
    const rc = responseContent as unknown as Record<string, unknown> | null;
    const choices = rc?.choices as Record<string, unknown>[] | undefined;
    const tcs = choices?.[0]?.message as Record<string, unknown> | undefined;
    for (const tc of (tcs?.tool_calls as Record<string, unknown>[]) ?? []) {
      entries.push({
        tool_call_id: String(tc.id),
        tool_name: (tc.function as Record<string, string>)?.name ?? '',
        arguments: (tc.function as Record<string, string>)?.arguments,
        result: results.get(String(tc.id)),
      });
    }
  } else if (apiType === 'anthropic') {
    const rc = responseContent as unknown as Record<string, unknown> | null;
    for (const block of rc?.content as Record<string, unknown>[] ?? []) {
      if (block.type !== 'tool_use' || !block.id) continue;
      entries.push({
        tool_call_id: String(block.id),
        tool_name: String(block.name ?? ''),
        arguments: typeof block.input === 'string' ? block.input as string : JSON.stringify(block.input),
        result: results.get(String(block.id)),
      });
    }
  }

  return entries;
}

export async function handlePassthrough(req: Request, res: Response): Promise<void> {
  const upstreamUrl = process.env.UPSTREAM_URL;
  if (!upstreamUrl) {
    res.status(500).json({ error: 'UPSTREAM_URL not configured' });
    return;
  }

  const targetUrl = upstreamUrl.replace(/\/$/, '') + req.path;

  console.log(`[passthrough] ${req.method} ${req.path} -> ${targetUrl}`);

  const upstreamHeaders = filterHeaders(req.headers as Record<string, string | string[] | undefined>);
  delete upstreamHeaders['host'];
  delete upstreamHeaders['content-length'];

  const fetchInit: RequestInit = {
    method: req.method,
    headers: upstreamHeaders,
  };

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
    fetchInit.body = JSON.stringify(req.body);
    if (!upstreamHeaders['content-type']) {
      upstreamHeaders['content-type'] = 'application/json';
    }
  }

  try {
    const upstreamRes = await fetch(targetUrl, fetchInit);
    const responseHeaders = filterHeaders(Object.fromEntries(upstreamRes.headers.entries()));

    res.status(upstreamRes.status);
    for (const [key, value] of Object.entries(responseHeaders)) {
      res.setHeader(key, value);
    }

    if (upstreamRes.body) {
      const reader = upstreamRes.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } finally {
        res.end();
        try { reader.releaseLock(); } catch { /* already released */ }
      }
    } else {
      res.end();
    }
  } catch (err) {
    const e = err as Error & { cause?: Error; code?: string };
    console.error(`[passthrough] error: ${e.message} (code=${e.code}) targetUrl=${targetUrl} cause=${e.cause?.message ?? e.cause ?? '-'}`);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Upstream unreachable', detail: String(err) });
    }
  }
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

  console.log(`[proxy] ${req.method} ${req.path} -> ${targetUrl}`);

  const upstreamHeaders = filterHeaders(req.headers as Record<string, string | string[] | undefined>);
  delete upstreamHeaders['host'];
  delete upstreamHeaders['content-length'];
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
      const rawText = await upstreamRes.text();
      console.error(`[proxy] response status=${responseStatus} contentType=${responseHeaders['content-type']} body=${rawText.slice(0, 2000)}`);
      let json: unknown;
      try {
        json = JSON.parse(rawText);
      } catch (parseErr) {
        console.error(`[proxy] JSON parse failed:`, (parseErr as Error).message);
        res.status(responseStatus).send(rawText);
        upsertRecord(baseRecord(id, req, responseStatus, false, apiType, startTime,
          `JSON parse error: ${(parseErr as Error).message}, raw=${rawText}`));
        return;
      }
      res.json(json);

      const record = baseRecord(id, req, responseStatus, false, apiType, startTime);
      record.responseContent = json as MergedContent;
      record.responseHeaders = responseHeaders;
      record.responseBody = JSON.stringify(json);
      record.state = 'done';
      record.finished = 'ok';
      record.tokenBreakdown = await computeTokenBreakdown(req.body, json as MergedContent, apiType) ?? undefined;
      upsertRecord(record);
      updateApiUsage(id, (json as unknown as Record<string, unknown>).usage);
      writeToolCalls(id, extractToolCalls(req.body, json as MergedContent, apiType));
    } else {
      // --- Streaming ---
      const record = baseRecord(id, req, responseStatus, true, apiType, startTime);
      record.responseHeaders = responseHeaders;
      upsertRecord(record);

      // 客户端断开监听
      req.on('close', () => {
        if (record.state === 'streaming') {
          record.finished = 'client_close';
          record.error = '客户端断开连接';
          record.state = 'error';
          upsertRecord(record);
        }
      });

      const reader = upstreamRes.body.getReader();
      const rawChunks: Uint8Array[] = [];
      let lastPush = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
          rawChunks.push(new Uint8Array(value));
          const now = Date.now();
          if (now - lastPush > 200) {
            record.streamText = Buffer.concat(rawChunks).toString('utf-8');
            upsertRecord(record);
            lastPush = now;
          }
        }
      } finally {
        res.end();
        try { reader.releaseLock(); } catch { /* already released */ }
      }

      // Parse SSE, merge, record
      const fullText = Buffer.concat(rawChunks).toString('utf-8');
      const chunks: SSEChunk[] = parseSSE(fullText, apiType);
      const merged = mergeChunks(chunks, apiType);

      record.responseContent = merged;
      record.chunks = chunks;
      record.responseBody = fullText;
      record.state = 'done';
      record.finished = 'ok';
      record.tokenBreakdown = await computeTokenBreakdown(req.body, merged, apiType) ?? undefined;
      delete record.streamText;
      upsertRecord(record);
      updateApiUsage(id, (merged as unknown as Record<string, unknown>).usage);
      writeToolCalls(id, extractToolCalls(req.body, merged, apiType));
    }
  } catch (err) {
    const e = err as Error & { cause?: Error; code?: string };
    console.error(`[proxy] error: ${e.message} (code=${e.code}) targetUrl=${targetUrl} cause=${e.cause?.message ?? e.cause ?? '-'}`);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Upstream unreachable', detail: String(err) });
    }
    upsertRecord(baseRecord(id, req, res.headersSent ? 200 : 502, isStreaming, apiType, startTime, String(err)));
  }
}
