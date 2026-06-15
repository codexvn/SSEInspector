import { EventEmitter } from 'events';
import { eq, desc, sql } from 'drizzle-orm';
import { RecordedRequest, RecordSummary, ApiType, MergedContent, TokenBreakdown } from './types';
import { db } from './db';
import { requests, toolCalls } from './db/schema';

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

// ---- 流式文本缓冲（内存 Map，临时存放流式进行中的 raw text） ----
const streamBuf = new Map<string, string>();

// ---- 内部 helper ----

function toSummary(r: RecordedRequest): RecordSummary {
  const model = ((r.responseContent as unknown as Record<string, unknown>)?.model as string)
    ?? ((r.requestBody as unknown as Record<string, unknown>)?.model as string)
    ?? 'unknown';

  // 从 requestBody.messages 取最新用户输入作为 preview
  let preview = '';
  const body = r.requestBody as Record<string, unknown> | undefined;
  const msgs = (body?.messages ?? body?.input) as { role: string; content: unknown }[] | undefined;
  if (msgs) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        const content = msgs[i].content;
        preview = typeof content === 'string' ? content : JSON.stringify(content);
        break;
      }
    }
  }
  if (!preview && r.error) preview = r.error;

  return {
    id: r.id,
    timestamp: r.timestamp,
    model,
    status: r.responseStatus,
    preview: preview.slice(0, 80),
    streaming: r.streaming,
    durationMs: r.durationMs,
    state: r.state,
    apiType: r.apiType,
    streamText: r.streamText,
  };
}

// ---- 从 SQLite 行重建 RecordedRequest ----

type RequestRow = typeof requests.$inferSelect;

function fromRow(row: RequestRow): RecordedRequest {
  return {
    id: row.id,
    timestamp: row.timestamp,
    method: row.method,
    path: row.path,
    upstreamUrl: row.upstream_url,
    apiType: row.api_type as ApiType,
    requestHeaders: (safeJsonParse(row.request_headers) as Record<string, string>) ?? {},
    requestBody: safeJsonParse(row.request_body),
    responseHeaders: safeJsonParse(row.response_headers) as Record<string, string> | undefined,
    responseContent: safeJsonParse(row.response_content) as MergedContent | null,
    responseBody: row.response_body ?? undefined,
    chunks: [],
    streaming: row.streaming === 1,
    state: row.finished !== 'pending' ? 'done' : row.error ? 'error' : 'streaming',
    streamText: streamBuf.get(row.id),
    responseStatus: row.status,
    durationMs: row.duration_ms,
    error: row.error ?? undefined,
    finished: row.finished,
    tokenBreakdown: (safeJsonParse(row.computed_tokens) as TokenBreakdown) ?? undefined,
  };
}

// ---- 从 SQLite 行构建 RecordSummary ----

type SummaryRow = Pick<RequestRow, 'id' | 'timestamp' | 'model' | 'status' | 'preview' | 'streaming' | 'duration_ms' | 'finished' | 'error' | 'api_type'>;

function rowToSummary(row: SummaryRow): RecordSummary {
  return {
    id: row.id,
    timestamp: row.timestamp,
    model: row.model,
    status: row.status,
    preview: row.preview ?? '',
    streaming: row.streaming === 1,
    durationMs: row.duration_ms,
    state: row.finished !== 'pending' ? 'done' : row.error ? 'error' : 'streaming',
    apiType: row.api_type as ApiType,
    streamText: streamBuf.get(row.id),
  };
}

function safeJsonParse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// ---- 公开 API ----

/** 新增或更新请求记录 */
export function upsertRecord(r: RecordedRequest): void {
  // 流式文本缓冲
  if (r.state === 'streaming' && r.streamText != null) {
    streamBuf.set(r.id, r.streamText);
  } else if (r.state !== 'streaming') {
    streamBuf.delete(r.id);
  }

  const summary = toSummary(r);

  const existing = db.select({ id: requests.id }).from(requests).where(eq(requests.id, r.id)).get();

  const row = {
    id: r.id,
    timestamp: r.timestamp,
    model: summary.model,
    method: r.method,
    path: r.path,
    upstream_url: r.upstreamUrl,
    api_type: r.apiType,
    status: r.responseStatus,
    streaming: r.streaming ? 1 : 0,
    finished: r.finished ?? (r.state === 'done' || r.state === 'error' ? 'ok' : 'pending'),
    error: r.error ?? null,
    duration_ms: r.durationMs,
    preview: summary.preview || null,
    request_headers: r.requestHeaders ? JSON.stringify(r.requestHeaders) : null,
    request_body: r.requestBody ? JSON.stringify(r.requestBody) : null,
    response_headers: r.responseHeaders ? JSON.stringify(r.responseHeaders) : null,
    response_content: r.responseContent ? JSON.stringify(r.responseContent) : null,
    response_body: r.responseBody ?? null,
    computed_tokens: r.tokenBreakdown ? JSON.stringify(r.tokenBreakdown) : null,
    api_usage: null,
  };

  if (existing) {
    db.update(requests).set(row).where(eq(requests.id, r.id)).run();
  } else {
    db.insert(requests).values(row).run();
  }

  emitter.emit('update', summary);
}

/** 更新 api_usage 列（proxy 完成后调用） */
export function updateApiUsage(id: string, usage: unknown): void {
  db.update(requests)
    .set({ api_usage: usage ? JSON.stringify(usage) : null })
    .where(eq(requests.id, id))
    .run();
}

/** 分页列表 */
export function getAll(page?: number, pageSize?: number): RecordSummary[] | { items: RecordSummary[]; total: number; page: number; pageSize: number } {
  if (page && pageSize) {
    const total = (db.select({ cnt: sql<number>`count(*)` }).from(requests).get())!.cnt;
    const rows = db.select({
      id: requests.id,
      timestamp: requests.timestamp,
      model: requests.model,
      status: requests.status,
      preview: requests.preview,
      streaming: requests.streaming,
      duration_ms: requests.duration_ms,
      finished: requests.finished,
      error: requests.error,
      api_type: requests.api_type,
    })
      .from(requests)
      .orderBy(desc(requests.timestamp))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();
    return { items: rows.map(rowToSummary), total, page, pageSize };
  }

  // 全量返回（向后兼容）
  const rows = db.select({
    id: requests.id,
    timestamp: requests.timestamp,
    model: requests.model,
    status: requests.status,
    preview: requests.preview,
    streaming: requests.streaming,
    duration_ms: requests.duration_ms,
    finished: requests.finished,
    error: requests.error,
    api_type: requests.api_type,
  })
    .from(requests)
    .orderBy(desc(requests.timestamp))
    .all();
  return rows.map(rowToSummary);
}

/** 详情查询 */
export function getById(id: string): RecordedRequest | undefined {
  const row = db.select().from(requests).where(eq(requests.id, id)).get();
  if (!row) return undefined;
  return fromRow(row);
}

/** 清空全部记录 */
export function clear(): void {
  streamBuf.clear();
  db.delete(toolCalls).run();
  db.delete(requests).run();
  emitter.emit('clear');
}

/** 写入工具调用 */
export interface ToolCallEntry {
  tool_call_id: string;
  tool_name: string;
  arguments?: string;
  result?: string;
}

export function writeToolCalls(requestId: string, entries: ToolCallEntry[]): void {
  if (entries.length === 0) return;
  const now = new Date().toISOString();
  for (const e of entries) {
    db.insert(toolCalls).values({
      request_id: requestId,
      tool_call_id: e.tool_call_id,
      tool_name: e.tool_name,
      arguments: e.arguments ?? null,
      result: e.result ?? null,
      created_at: now,
    }).run();
  }
}

/** 查询某次请求的全部工具调用 */
export function getToolCalls(requestId: string): ToolCallEntry[] {
  return db.select({
    tool_call_id: toolCalls.tool_call_id,
    tool_name: toolCalls.tool_name,
    arguments: toolCalls.arguments,
    result: toolCalls.result,
  })
    .from(toolCalls)
    .where(eq(toolCalls.request_id, requestId))
    .all()
    .map(r => ({ ...r, arguments: r.arguments ?? undefined, result: r.result ?? undefined }));
}

/** 工具调用配对查询 */
export function getToolCallPair(
  _requestId: string, toolName: string, toolCallId: string
): { prevResult?: string; nextRequest?: string } {
  const callRow = db.select({ arguments: toolCalls.arguments })
    .from(toolCalls)
    .where(
      sql`${toolCalls.tool_name} = ${toolName} AND ${toolCalls.tool_call_id} = ${toolCallId} AND ${toolCalls.arguments} IS NOT NULL`
    )
    .limit(1)
    .get();

  const resultRow = db.select({ result: toolCalls.result })
    .from(toolCalls)
    .where(
      sql`${toolCalls.tool_name} = ${toolName} AND ${toolCalls.tool_call_id} = ${toolCallId} AND ${toolCalls.result} IS NOT NULL`
    )
    .limit(1)
    .get();

  return {
    nextRequest: callRow?.arguments ?? undefined,
    prevResult: resultRow?.result ?? undefined,
  };
}

/** SSE 实时推送 */
export function onUpdate(cb: (summary: RecordSummary) => void): () => void {
  emitter.on('update', cb);
  return () => emitter.off('update', cb);
}

export function onClear(cb: () => void): () => void {
  emitter.on('clear', cb);
  return () => emitter.off('clear', cb);
}

// ---- 暴露流式缓冲，供 SSE 使用 ----
export { streamBuf };
