import { Entity, PrimaryGeneratedColumn, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { RequestEntity } from './RequestEntity';

/** 工具调用独立行。每个 tool_call 一行，arguments=调用参数，result=执行结果。 */
@Entity('tool_calls')
@Index('idx_tool_calls_pair', ['tool_name', 'tool_call_id'])
export class ToolCall {
  @PrimaryGeneratedColumn()
  id!: number;

  /** 关联 requests.id，按此列查该次请求的全部工具调用 → 索引 idx_tool_calls_req */
  @Column('text')
  @Index('idx_tool_calls_req')
  request_id!: string;

  /** 模型返回的 tool call id（OpenAI: tc.id, Anthropic: block.id） */
  @Column('text')
  tool_call_id!: string;

  /** 函数名（OpenAI: tc.function.name, Anthropic: block.name） */
  @Column('text')
  tool_name!: string;

  /** JSON 调用参数，NULL 表示纯结果行 */
  @Column('text', { nullable: true })
  arguments?: string | null;

  /** 工具返回结果，NULL 表示纯请求行 */
  @Column('text', { nullable: true })
  result?: string | null;

  /** ISO 写入时间 */
  @Column('text')
  created_at!: string;

  @ManyToOne(() => RequestEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'request_id' })
  request!: RequestEntity;
}
