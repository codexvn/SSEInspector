import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { RequestEntity } from '../entity/RequestEntity';
import { ToolCall } from '../entity/ToolCall';
import { config } from '../config';

/**
 * 解析数据库路径。
 *
 * 由 CLI 入口（bin/sse-inspector.js）通过 setConfig 填充 config.dbPath。
 * config.assertConfigured 已在 DataSource 求值前兜底空值，此处直接返回。
 */
function resolveDbPath(): string {
  return config.dbPath;
}

export const AppDataSource = new DataSource({
  type: 'better-sqlite3',
  database: resolveDbPath(),
  synchronize: true,
  entities: [RequestEntity, ToolCall],
});

/** 异步初始化：WAL + FK + 标记未完成，完成后回调启动服务 */
export async function initDb(): Promise<void> {
  await AppDataSource.initialize();
  await AppDataSource.query('PRAGMA journal_mode = WAL');
  await AppDataSource.query('PRAGMA foreign_keys = ON');

  // 标记未完成的请求（finished='pending' → 进程异常退出）
  const repo = AppDataSource.getRepository(RequestEntity);
  await repo.update(
    { finished: 'pending' },
    { finished: 'startup_fallback' },
  );
  console.log(`[db] SQLite 已就绪: ${AppDataSource.options.database}`);
}
