import { EventEmitter } from 'events';
import { RecordedRequest, RecordSummary, ApiType, MergedContent, TokenBreakdown, RecordState } from './types';
import { AppDataSource } from './db';
import { RequestEntity } from './entity/RequestEntity';
import { ToolCall } from './entity/ToolCall';
import { Not, IsNull, Repository } from 'typeorm';

const emitter = new EventEmitter();
emitter.setMaxListeners(500);

// ---- 流式文本缓冲（内存 Map，临时存放流式进行中的 raw text） ----
const streamBuf = new Map<string, string>();

// ---- repository 懒加载 ----

let _reqRepo: Repository<RequestEntity> | null = null;
let _toolRepo: Repository<ToolCall> | null = null;
function reqRepo() { return _reqRepo ?? (_reqRepo = AppDataSource.getRepository(RequestEntity)); }
function toolRepo() { return _toolRepo ?? (_toolRepo = AppDataSource.getRepository(ToolCall)); }

// ---- 内部 helper ----

function toSummary(r: RecordedRequest): RecordSummary {
  const model = ((r.responseContent as unknown as Record<string, unknown>)?.model as string)
    ?? ((r.requestBody as unknown as Record<string, unknown>)?.model as string)
    ?? 'unknown';

  // 从 requestBody 取最新用户输入作为列表 preview
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

function entityToRecord(row: RequestEntity): RecordedRequest {
  return {
    id: row.id,
    timestamp: row.timestamp,
    method: row.method,
    path: row.path,
    upstreamUrl: row.upstream_url,
    apiType: row.api_type as ApiType,
    requestHeaders: (safeJsonParse(row.request_headers ?? null) as Record<string, string>) ?? {},
    requestBody: safeJsonParse(row.request_body ?? null),
    responseHeaders: safeJsonParse(row.response_headers ?? null) as Record<string, string> | undefined,
    responseContent: safeJsonParse(row.response_content ?? null) as MergedContent | null,
    responseBody: row.response_body ?? undefined,
    streaming: row.streaming === 1,
    state: deriveState(row.finished, row.error ?? null),
    streamText: streamBuf.get(row.id),
    responseStatus: row.status,
    durationMs: row.duration_ms,
    error: row.error ?? undefined,
    finished: row.finished,
    tokenBreakdown: (safeJsonParse(row.computed_tokens ?? null) as TokenBreakdown) ?? undefined,
    apiUsage: row.api_usage ?? undefined,
  };
}

function entityToSummary(row: RequestEntity): RecordSummary {
  return {
    id: row.id,
    timestamp: row.timestamp,
    model: row.model,
    status: row.status,
    preview: row.preview ?? '',
    streaming: row.streaming === 1,
    durationMs: row.duration_ms,
    state: deriveState(row.finished, row.error ?? null),
    apiType: row.api_type as ApiType,
    streamText: streamBuf.get(row.id),
  };
}

function safeJsonParse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function deriveState(finished: string, error: string | null): RecordState {
  if (finished !== 'pending') return 'done';
  if (error) return 'error';
  return 'streaming';
}

// 列表查询的 select 列（跳过 blob，保证分页性能）
const SUMMARY_SELECT = {
  id: true, timestamp: true, model: true, status: true, preview: true,
  streaming: true, duration_ms: true, finished: true, error: true, api_type: true,
};

// ---- 公开 API ----

/** 新增或更新请求记录 */
export async function upsertRecord(r: RecordedRequest): Promise<void> {
  // 流式文本缓冲
  if (r.state === 'streaming' && r.streamText != null) {
    streamBuf.set(r.id, r.streamText);
  } else if (r.state !== 'streaming') {
    streamBuf.delete(r.id);
  }

  const summary = toSummary(r);
  const repo = reqRepo();

  // 流式中间更新 vs 全量写入
  const existing = await repo.findOneBy({ id: r.id });
  if (existing && r.state === 'streaming') {
    // 流式进行中：仅更新轻量列，不重写 blob（避免每 200ms 重写 MB 级 JSON）
    await repo.update({ id: r.id }, {
      duration_ms: r.durationMs,
      status: r.responseStatus,
      model: summary.model,
      preview: summary.preview || null,
    });
  } else {
    // 全量写入（流式开始 / 流式完成 / 非流式 / 错误）
    await repo.save({
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
      error: r.error ?? undefined,
      duration_ms: r.durationMs,
      preview: summary.preview || null,
      request_headers: r.requestHeaders ? JSON.stringify(r.requestHeaders) : undefined,
      request_body: r.requestBody ? JSON.stringify(r.requestBody) : undefined,
      response_headers: r.responseHeaders ? JSON.stringify(r.responseHeaders) : undefined,
      response_content: r.responseContent ? JSON.stringify(r.responseContent) : undefined,
      response_body: r.responseBody ?? undefined,
      computed_tokens: r.tokenBreakdown ? JSON.stringify(r.tokenBreakdown) : undefined,
      api_usage: r.apiUsage ?? null,
    });
  }

  emitter.emit('update', summary);
}

/** 分页列表 */
export async function getAll(page?: number, pageSize?: number): Promise<RecordSummary[] | { items: RecordSummary[]; total: number; page: number; pageSize: number }> {
  const repo = reqRepo();
  if (page && pageSize) {
    const [rows, total] = await repo.findAndCount({
      select: SUMMARY_SELECT,
      order: { timestamp: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items: rows.map(entityToSummary), total, page, pageSize };
  }
  const rows = await repo.find({
    select: SUMMARY_SELECT,
    order: { timestamp: 'DESC' },
  });
  return rows.map(entityToSummary);
}

/** 详情查询 */
export async function getById(id: string): Promise<RecordedRequest | undefined> {
  const row = await reqRepo().findOneBy({ id });
  if (!row) return undefined;
  return entityToRecord(row);
}

/** 清空全部记录 */
export async function clear(): Promise<void> {
  streamBuf.clear();
  await toolRepo().delete({});
  await reqRepo().delete({});
  emitter.emit('clear');
}

/** 写入工具调用 */
export interface ToolCallEntry {
  tool_call_id: string;
  tool_name: string;
  arguments?: string;
  result?: string;
}

export async function writeToolCalls(requestId: string, entries: ToolCallEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const now = new Date().toISOString();
  await toolRepo().save(entries.map(e => ({
    request_id: requestId,
    tool_call_id: e.tool_call_id,
    tool_name: e.tool_name,
    arguments: e.arguments ?? undefined,
    result: e.result ?? undefined,
    created_at: now,
  })));
}

/** 回填 tool_calls 的 result 列（工具返回结果在下一轮请求的 requestBody 中携带） */
export async function updateToolCallResults(updates: { tool_call_id: string; result: string }[]): Promise<void> {
  if (updates.length === 0) return;
  const repo = toolRepo();
  for (const u of updates) {
    await repo.update(
      { tool_call_id: u.tool_call_id, result: IsNull() },
      { result: u.result },
    );
  }
}

/** 查询某次请求的全部工具调用 */
export async function getToolCalls(requestId: string): Promise<ToolCallEntry[]> {
  const rows = await toolRepo().find({ where: { request_id: requestId } });
  return rows.map(r => ({
    tool_call_id: r.tool_call_id,
    tool_name: r.tool_name,
    arguments: r.arguments ?? undefined,
    result: r.result ?? undefined,
  }));
}

/** 工具调用配对查询 */
export async function getToolCallPair(
  toolName: string, toolCallId: string,
): Promise<{ prevResult?: string; nextRequest?: string }> {
  const callRow = await toolRepo().findOne({
    where: { tool_name: toolName, tool_call_id: toolCallId, arguments: Not(IsNull()) },
    select: { arguments: true },
    order: { id: 'ASC' },
  });
  const resultRow = await toolRepo().findOne({
    where: { tool_name: toolName, tool_call_id: toolCallId, result: Not(IsNull()) },
    select: { result: true },
    order: { id: 'ASC' },
  });

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
