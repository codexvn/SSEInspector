import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from './schema';

/** 启动参数优先级：--db-path > SQLITE_PATH 环境变量 */
function resolveDbPath(): string {
  const dbIdx = process.argv.indexOf('--db-path');
  if (dbIdx !== -1 && process.argv[dbIdx + 1]) return process.argv[dbIdx + 1];
  if (process.env.SQLITE_PATH) return process.env.SQLITE_PATH;
  console.error('[db] 请指定 SQLite 数据库路径: --db-path <path> 或 SQLITE_PATH 环境变量');
  process.exit(1);
}

const sqlitePath = resolveDbPath();
const sqlite = new Database(sqlitePath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

// 启动时标记未完成的请求（finished='pending' → 进程异常退出）
db.update(schema.requests)
  .set({ finished: 'startup_fallback' })
  .where(eq(schema.requests.finished, 'pending'))
  .run();

console.log(`[db] SQLite 已就绪: ${sqlitePath}`);
