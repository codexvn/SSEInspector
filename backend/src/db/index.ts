import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { RequestEntity } from '../entity/RequestEntity';
import { ToolCall } from '../entity/ToolCall';

function resolveDbPath(): string {
  // --db-path <path>
  const dbIdx = process.argv.indexOf('--db-path');
  if (dbIdx !== -1 && process.argv[dbIdx + 1]) return process.argv[dbIdx + 1];
  // 第一个非参数、非脚本的裸路径
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith('-') && !a.includes('node_modules') && !a.endsWith('.ts')) return a;
  }
  if (process.env.SQLITE_PATH) return process.env.SQLITE_PATH;
  console.error('[db] 请指定 SQLite 数据库路径:');
  console.error('    SQLITE_PATH=./data.db npm start');
  console.error('    npm start -- ./data.db');
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
