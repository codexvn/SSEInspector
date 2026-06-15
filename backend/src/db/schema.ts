import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

// ════════════════════════════════════════════════════════
// 表1：requests — 请求主表
// ════════════════════════════════════════════════════════
export const requests = sqliteTable('requests', {
  // ===== 主键 =====
  id: text('id').primaryKey(),
  //    ↑ UUID v4，proxy.ts 中 crypto.randomUUID() 生成

  // ===== 请求元数据（创建时写入，之后不变）=====
  timestamp: text('timestamp').notNull(),
  //    ↑ ISO 8601 时间戳，列表 ORDER BY timestamp DESC 排序依据 → ⚡索引 idx_requests_ts
  model: text('model').notNull().default('unknown'),
  //    ↑ 模型名，从 responseContent.model 提取，fallback 到 requestBody.model，列表 + 详情
  method: text('method').notNull(),
  //    ↑ HTTP 方法（POST），详情页显示 + cURL 复制
  path: text('path').notNull(),
  //    ↑ 请求路径 /chat/completions 等，详情页显示
  upstream_url: text('upstream_url').notNull(),
  //    ↑ 上游完整 URL，详情页 cURL 复制
  api_type: text('api_type').notNull(),
  //    ↑ 'openai' | 'anthropic'，列表 badge + 统计

  // ===== 响应元数据（创建时写默认值，流式期间 UPDATE，完成后定稿）=====
  status: integer('status').notNull().default(0),
  //    ↑ HTTP 状态码，列表 badge + 详情
  streaming: integer('streaming').notNull().default(0),
  //    ↑ 0/1，创建时写入不变，详情页显示"流式: 是/否"
  finished: text('finished').notNull().default('pending'),
  //    ↑ 'pending' | 'ok' | 'client_close' | 'startup_fallback'
  //      pending: 请求进行中
  //      ok: 正常结束（proxy 成功时设置）
  //      client_close: 客户端断开（req.on('close') 触发）
  //      startup_fallback: 启动时标记（store initDb 检测未完成请求）
  error: text('error'),
  //    ↑ 错误信息，仅失败时非 null，列表 preview 回退 + 详情
  duration_ms: integer('duration_ms').notNull().default(0),
  //    ↑ 耗时毫秒，列表 + 详情显示

  // ===== 列表物化列（写时计算，分页不碰 blob）=====
  preview: text('preview'),
  //    ↑ 最新用户输入前 80 字符，toSummary() 从 requestBody.messages 提取

  // ===== 请求详情（JSON TEXT 列，仅详情页 getById() 读取；流式 INSERT 时为 NULL，完成时 UPDATE）=====
  request_headers: text('request_headers'),
  //    ↑ JSON {key:value}，详情页请求头面板
  request_body: text('request_body'),
  //    ↑ JSON 完整请求体（messages 历史 + tools 定义 + system prompt，可达 MB），详情页 Monaco 展示
  response_headers: text('response_headers'),
  //    ↑ JSON {key:value}，详情页响应头面板
  response_content: text('response_content'),
  //    ↑ JSON 合并后的 AI 响应（结构取决于 apiType），详情页主要内容渲染
  response_body: text('response_body'),
  //    ↑ 原始响应文本（非流式=JSON.stringify，流式=完整 SSE raw text，含 event: 和 data: 行）
  //    也是 SSE 审计回放的完整源数据：parseSSE() → mergeChunks() → responseContent

  // ===== Token 分解（两组 JSON，详情页 Token 用量表格，完成后写入）=====
  computed_tokens: text('computed_tokens'),
  //    ↑ JSON { messages, tools, systemPrompt, totalInput }，tokenizer 计算结果
  api_usage: text('api_usage'),
  //    ↑ JSON，接口原始返回的 usage 对象（字段因供应商而异），直接透传
}, (table) => ({
  tsIdx: index('idx_requests_ts').on(table.timestamp),
}));

// ════════════════════════════════════════════════════════
// 表2：tool_calls — 工具调用独立行
// ════════════════════════════════════════════════════════
export const toolCalls = sqliteTable('tool_calls', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  //    ↑ 自增主键

  request_id: text('request_id').notNull()
    .references(() => requests.id, { onDelete: 'cascade' }),
  //    ↑ 关联 requests.id → ⚡索引 idx_tool_calls_req

  tool_call_id: text('tool_call_id').notNull(),
  //    ↑ 模型返回的 tool call id → ⚡联合索引 idx_tool_calls_pair

  tool_name: text('tool_name').notNull(),
  //    ↑ 函数名 → ⚡联合索引 idx_tool_calls_pair

  arguments: text('arguments'),
  //    ↑ JSON，调用参数（NULL 表示纯结果行）

  result: text('result'),
  //    ↑ 工具返回结果（NULL 表示纯请求行）

  created_at: text('created_at').notNull(),
  //    ↑ ISO 写入时间
}, (table) => ({
  reqIdx:  index('idx_tool_calls_req').on(table.request_id),
  pairIdx: index('idx_tool_calls_pair').on(table.tool_name, table.tool_call_id),
}));
