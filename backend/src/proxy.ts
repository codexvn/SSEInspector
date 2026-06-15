import { Request, Response } from 'express';
import { upsertRecord, writeToolCalls, updateToolCallResults, ToolCallEntry } from './store';
import { parseSSE, mergeChunks } from './sse-merger';
import { computeTokenBreakdown } from './token-counter';
import { RecordedRequest, ApiType, MergedContent } from './types';

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

/** 从请求头中按已知列表提取 session ID，返回 { value, key } 或 null */
function extractSessionId(req: Request): { value: string; key: string } | null {
  const headers = req.headers as Record<string, string | string[] | undefined>;
  for (const name of KNOWN_SESSION_HEADERS) {
    const v = headers[name];
    if (v) {
      const value = Array.isArray(v) ? v[0] : v;
      if (value) return { value, key: name };
    }
  }
  return null;
}

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
  const sid = extractSessionId(req);
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
    sessionId: sid?.value,
    sessionIdKey: sid?.key,
  };
}

/** 从 requestBody 提取 tool_result（上一轮工具调用的返回结果），
 *  更新之前已写入的 tool_calls 行的 result 列。
 *  工具调用的 result 在下一次请求的 requestBody 中携带，
 *  因此必须在 proxy 开始时检查，不能在请求完成时。 */
async function backfillToolResults(requestBody: unknown, apiType: ApiType): Promise<void> {
  const updates: { tool_call_id: string; result: string }[] = [];
  const body = requestBody as Record<string, unknown> | undefined;
  if (!body) return;

  // messages[] 格式（OpenAI Chat / Anthropic）
  const msgList = body.messages as Record<string, unknown>[] | undefined;
  const extractMsgs = (msgs: Record<string, unknown>[]) => {
    for (const msg of msgs) {
      if (apiType === 'openai' && msg.role === 'tool' && msg.tool_call_id) {
        const c = msg.content;
        updates.push({ tool_call_id: String(msg.tool_call_id), result: typeof c === 'string' ? c : JSON.stringify(c) });
      }
      if (apiType === 'anthropic' && Array.isArray(msg.content)) {
        for (const block of msg.content as Record<string, unknown>[]) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const c = block.content;
            updates.push({ tool_call_id: String(block.tool_use_id), result: typeof c === 'string' ? c : JSON.stringify(c) });
          }
        }
      }
    }
  };
  if (msgList) extractMsgs(msgList);

  // input[] 格式（Anthropic 新格式 / OpenAI Responses）
  const input = body.input as Record<string, unknown>[] | undefined;
  if (input) extractMsgs(input);

  if (updates.length > 0) await updateToolCallResults(updates);
}

/** 从 responseContent 提取 tool_use（本轮模型发出的工具调用请求），
 *  不配对 result——result 在下一次请求中才会出现。 */
function extractToolCalls(
  responseContent: MergedContent | null,
  apiType: ApiType,
): ToolCallEntry[] {
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

  // 回填上一轮工具调用的返回结果（result 在下一次请求的 requestBody 中）
  await backfillToolResults(req.body, apiType);

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
        await upsertRecord(baseRecord(id, req, responseStatus, false, apiType, startTime,
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
      record.apiUsage = JSON.stringify((json as any)?.usage);
      await upsertRecord(record);
      await writeToolCalls(id, extractToolCalls(json as MergedContent, apiType));
    } else {
      // --- Streaming ---
      const record = baseRecord(id, req, responseStatus, true, apiType, startTime);
      record.responseHeaders = responseHeaders;
      await upsertRecord(record);

      // 客户端断开监听
      req.on('close', async () => {
        if (record.state === 'streaming') {
          record.finished = 'client_close';
          record.error = '客户端断开连接';
          record.state = 'error';
          await upsertRecord(record);
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
            await upsertRecord(record);
            lastPush = now;
          }
        }
      } finally {
        res.end();
        try { reader.releaseLock(); } catch { /* already released */ }
      }

      // Parse SSE, merge, record
      const fullText = Buffer.concat(rawChunks).toString('utf-8');
      const merged = mergeChunks(parseSSE(fullText, apiType), apiType);

      record.responseContent = merged;
      record.responseBody = fullText;
      record.state = 'done';
      record.finished = 'ok';
      record.tokenBreakdown = await computeTokenBreakdown(req.body, merged, apiType) ?? undefined;
      record.apiUsage = JSON.stringify((merged as any)?.usage);
      delete record.streamText;
      await upsertRecord(record);
      await writeToolCalls(id, extractToolCalls(merged, apiType));
    }
  } catch (err) {
    const e = err as Error & { cause?: Error; code?: string };
    console.error(`[proxy] error: ${e.message} (code=${e.code}) targetUrl=${targetUrl} cause=${e.cause?.message ?? e.cause ?? '-'}`);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Upstream unreachable', detail: String(err) });
    }
    await upsertRecord(baseRecord(id, req, res.headersSent ? 200 : 502, isStreaming, apiType, startTime, String(err)));
  }
}
