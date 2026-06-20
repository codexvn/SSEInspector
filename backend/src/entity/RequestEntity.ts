import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

/** 请求主表。每个被代理的 AI API 请求对应一行。 */
@Entity('requests')
@Index('idx_requests_api_type_ts', ['api_type', 'timestamp'])
@Index('idx_requests_finished_ts', ['finished', 'timestamp'])
@Index('idx_requests_error_ts', ['error', 'timestamp'])
export class RequestEntity {
  /** UUID v4，proxy.ts 中 crypto.randomUUID() 生成 */
  @PrimaryColumn('text')
  id!: string;

  /** ISO 8601 时间戳，列表 ORDER BY 排序依据 → 索引 idx_requests_ts */
  @Column('text')
  @Index('idx_requests_ts')
  timestamp!: string;

  /** 模型名，从 responseContent.model 提取，fallback 到 requestBody.model */
  @Column('text', { default: 'unknown' })
  model!: string;

  @Column('text')
  method!: string;

  @Column('text')
  path!: string;

  @Column('text')
  upstream_url!: string;

  /** 'openai' | 'anthropic' */
  @Column('text')
  api_type!: string;

  @Column('integer', { default: 0 })
  status!: number;

  /** 0=非流式 1=流式，创建时写入不变 */
  @Column('integer', { default: 0 })
  streaming!: number;

  /** 'pending'|'ok'|'client_close'|'startup_fallback'，状态机见计划文档 */
  @Column('text', { default: 'pending' })
  finished!: string;

  /** 错误信息，仅失败时非 null */
  @Column('text', { nullable: true })
  error?: string | null;

  /** 耗时毫秒 */
  @Column('integer', { default: 0 })
  duration_ms!: number;

  /** 列表预览：最新用户输入前 80 字符，toSummary() 从 requestBody.messages 提取 */
  @Column('text', { nullable: true })
  preview?: string | null;

  /** JSON {key:value}，请求头 */
  @Column('text', { nullable: true })
  request_headers?: string | null;

  /** JSON 完整请求体（messages+工具+system prompt，可达 MB），详情页 Monaco */
  @Column('text', { nullable: true })
  request_body?: string | null;

  /** JSON {key:value}，响应头 */
  @Column('text', { nullable: true })
  response_headers?: string | null;

  /** JSON 合并后的 AI 响应对象，详情页主要内容渲染源 */
  @Column('text', { nullable: true })
  response_content?: string | null;

  /** 原始响应文本（非流式=JSON，流式=完整 SSE raw text 含 event/data 行） */
  @Column('text', { nullable: true })
  response_body?: string | null;

  /** JSON {messages,tools,systemPrompt,totalInput}，tokenizer 计算结果 */
  @Column('text', { nullable: true })
  computed_tokens?: string | null;

  /** JSON 接口原始 usage 对象，字段因供应商而异 */
  @Column('text', { nullable: true })
  api_usage?: string | null;

  /** 会话标识（从已知请求头提取），加索引以支持按会话聚合查询 */
  @Column('text', { nullable: true })
  @Index('idx_requests_session_id')
  session_id?: string | null;

  /** 会话标识来源头名称（如 x-claude-code-session-id） */
  @Column('text', { nullable: true })
  session_id_key?: string | null;
}
