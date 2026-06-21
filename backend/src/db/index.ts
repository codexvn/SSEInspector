import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { RequestEntity } from '../entity/RequestEntity';
import { ToolCall } from '../entity/ToolCall';
import { config } from '../config';

/**
 * 解析数据库路径。
 *
 * 生产模式（经 bin/sse-inspector.js 启动）：config.dbPath 已由 CLI 入口设置。
 * 开发模式（tsx 直接运行 index.ts）：回退到 SQLITE_PATH 环境变量，
 *   保持 `npm start` 走 tsx 时的向后兼容。
 */
function resolveDbPath(): string {
  if (config.dbPath) return config.dbPath;
  if (process.env.SQLITE_PATH) return process.env.SQLITE_PATH;
  console.error('[db] 请指定 SQLite 数据库路径:');
  console.error('    生产模式: sse-inspector --upstream URL --db-path ./data.db');
  console.error('    开发模式: SQLITE_PATH=./data.db npm start');
  process.exit(1);
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
