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
  // 优先取请求体 model（请求模型与返回模型 ID 可能不同，列表以请求模型为准）
  const model = ((r.requestBody as unknown as Record<string, unknown>)?.model as string)
    ?? ((r.responseContent as unknown as Record<string, unknown>)?.model as string)
    ?? 'unknown';

  const preview = buildPreview(r);

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
    path: r.path,
    streamText: r.streamText,
    ...buildTokenSummary(r.tokenBreakdown, r.apiUsage),
    sessionId: r.sessionId,
    sessionIdKey: r.sessionIdKey,
  };
}

function buildPreview(record: RecordedRequest): string {
  const body = isRecord(record.requestBody) ? record.requestBody : undefined;
  const userInput = latestUserInput(body);
  if (userInput) return userInput;
  return record.error ?? '';
}

function latestUserInput(body?: Record<string, unknown>): string {
  if (!body) return '';

  const messages = arrayOfRecords(body.messages);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'user') return extractText(message.content);
  }

  const input = body.input;
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';

  for (let index = input.length - 1; index >= 0; index--) {
    const item = input[index];
    if (!isRecord(item)) continue;
    const type = String(item.type ?? '');
    const role = String(item.role ?? '');
    if (role === 'user' || type === 'message') {
      return extractText(item.content) || extractText(item);
    }
  }
  return '';
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n');
  if (!isRecord(value)) return '';
  return stringValue(value.text ?? value.input_text ?? value.output_text ?? value.thinking)
    ?? extractText(value.content);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** 从原始 usage JSON 提取输出 token 数（兼容 OpenAI completion_tokens 与 Anthropic/DeepSeek/Responses output_tokens） */
function extractOutputTokens(apiUsage?: string | null): number | undefined {
  if (!apiUsage) return undefined;
  try {
    const usage = JSON.parse(apiUsage) as Record<string, unknown>;
    const out = (usage as { completion_tokens?: number; output_tokens?: number }).completion_tokens
      ?? (usage as { output_tokens?: number }).output_tokens;
    return typeof out === 'number' ? out : undefined;
  } catch (err) {
    console.warn(`[store] 解析 apiUsage 提取输出 token 失败: ${formatErrorChain(err)}`);
    return undefined;
  }
}

function buildTokenSummary(tb?: TokenBreakdown | null, apiUsage?: string | null): Pick<RecordSummary, 'cacheRead' | 'apiReportedInput' | 'outputTokens'> {
  return {
    cacheRead: tb?.cacheRead,
    apiReportedInput: tb?.apiReportedInput,
    outputTokens: extractOutputTokens(apiUsage),
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
    // requestBody 可达 MB 级 ——透传 raw string，前端按需 parse
    requestBody: row.request_body ?? null,
    responseHeaders: safeJsonParse(row.response_headers ?? null) as Record<string, string> | undefined,
    responseContent: safeJsonParse(row.response_content ?? null) as MergedContent | null,
    // responseBody 可达 MB 级 ——透传 raw string，前端直接显示
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
    outputTokens: extractOutputTokens(row.api_usage),
    sessionId: row.session_id ?? undefined,
    sessionIdKey: row.session_id_key ?? undefined,
  };
}

function entityToSummary(row: RequestEntity): RecordSummary {
  // 从 computed_tokens JSON 字段提取缓存命中数和 API 报告的输入 token
  let tokenBreakdown: TokenBreakdown | null = null
  if (row.computed_tokens) {
    try {
      tokenBreakdown = JSON.parse(row.computed_tokens) as TokenBreakdown
    } catch (err) {
      console.warn(`[store] 解析 computed_tokens JSON 失败: ${formatErrorChain(err)}`);
    }
  }

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
    path: row.path ?? undefined,
    streamText: streamBuf.get(row.id),
    ...buildTokenSummary(tokenBreakdown, row.api_usage),
    sessionId: row.session_id ?? undefined,
    sessionIdKey: row.session_id_key ?? undefined,
  };
}

function safeJsonParse(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (err) {
    console.warn(`[store] JSON 解析失败: ${formatErrorChain(err)}`);
    return null;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
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
  computed_tokens: true, session_id: true, session_id_key: true,
  path: true, api_usage: true,
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
      session_id: r.sessionId ?? null,
      session_id_key: r.sessionIdKey ?? null,
    });
  }

  emitter.emit('update', summary);
}

/** 分页列表 */
export async function getAll(page?: number, pageSize?: number): Promise<RecordSummary[] | { items: RecordSummary[]; total: number; page: number; pageSize: number; counts?: { openai: number; anthropic: number; streaming: number; error: number } }> {
  const repo = reqRepo();
  if (page && pageSize) {
    const [rows, total] = await repo.findAndCount({
      select: SUMMARY_SELECT,
      order: { timestamp: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    // 全量统计（不受分页影响）
    const openaiCount = await repo.count({ where: { api_type: 'openai' } });
    const anthropicCount = await repo.count({ where: { api_type: 'anthropic' } });
    const streamingCount = await repo.count({ where: { finished: 'pending' } });
    const errorCount = await repo.count({ where: { error: Not(IsNull()) } });
    return { items: rows.map(entityToSummary), total, page, pageSize, counts: { openai: openaiCount, anthropic: anthropicCount, streaming: streamingCount, error: errorCount } };
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

/** 查询同一会话中指定请求的上一条请求（不限定完成状态，实时反映流式中的相邻请求） */
export async function getPrevInSession(id: string, sessionId: string): Promise<RecordedRequest | undefined> {
  const repo = reqRepo();
  const row = await repo
    .createQueryBuilder('r')
    .where('r.session_id = :sid', { sid: sessionId })
    .andWhere('r.timestamp < (SELECT timestamp FROM requests WHERE id = :id)', { id })
    .orderBy('r.timestamp', 'DESC')
    .limit(1)
    .getOne();
  return row ? entityToRecord(row) : undefined;
}

/** 查询同一会话中指定请求的下一条请求 */
export async function getNextInSession(id: string, sessionId: string): Promise<RecordedRequest | undefined> {
  const repo = reqRepo();
  const row = await repo
    .createQueryBuilder('r')
    .where('r.session_id = :sid', { sid: sessionId })
    .andWhere('r.timestamp > (SELECT timestamp FROM requests WHERE id = :id)', { id })
    .orderBy('r.timestamp', 'ASC')
    .limit(1)
    .getOne();
  return row ? entityToRecord(row) : undefined;
}

/** 全量统计（实时查询 DB，供列表页顶部统计直接刷新） */
export async function getStats(): Promise<{ total: number; openai: number; anthropic: number; streaming: number; error: number }> {
  const repo = reqRepo();
  const total = await repo.count();
  const openai = await repo.count({ where: { api_type: 'openai' } });
  const anthropic = await repo.count({ where: { api_type: 'anthropic' } });
  const streaming = await repo.count({ where: { finished: 'pending' } });
  const error = await repo.count({ where: { error: Not(IsNull()) } });
  return { total, openai, anthropic, streaming, error };
}

/** 全局相邻与序号（按时间降序）：供详情页全局导航直接查接口刷新 */
export async function getGlobalNeighbors(id: string): Promise<{ prevId: string | null; nextId: string | null; index: number; total: number }> {
  const repo = reqRepo();
  const total = await repo.count();
  // 上一条（时间更早，降序排在后面）
  const prevRow = await repo
    .createQueryBuilder('r')
    .select('r.id', 'id')
    .where('r.timestamp < (SELECT timestamp FROM requests WHERE id = :id)', { id })
    .orderBy('r.timestamp', 'DESC')
    .limit(1)
    .getRawOne<{ id: string }>();
  // 下一条（时间更晚，降序排在前面的）
  const nextRow = await repo
    .createQueryBuilder('r')
    .select('r.id', 'id')
    .where('r.timestamp > (SELECT timestamp FROM requests WHERE id = :id)', { id })
    .orderBy('r.timestamp', 'ASC')
    .limit(1)
    .getRawOne<{ id: string }>();
  // 序号：时间更晚的条数 + 1（降序中第几个）
  const later = await repo
    .createQueryBuilder('r')
    .select('COUNT(*)', 'cnt')
    .where('r.timestamp > (SELECT timestamp FROM requests WHERE id = :id)', { id })
    .getRawOne<{ cnt: string }>();
  const index = Number(later?.cnt ?? 0) + 1;
  return { prevId: prevRow?.id ?? null, nextId: nextRow?.id ?? null, index, total };
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
