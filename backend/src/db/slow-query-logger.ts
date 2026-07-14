import { SimpleConsoleLogger } from 'typeorm';
import { getLogger } from '../logger';

const logger = getLogger('db');

/** 仅记录慢查询耗时与 SQL，避免大字段参数让日志本身阻塞 Recorder Worker。 */
export class SlowQueryLogger extends SimpleConsoleLogger {
  override logQuerySlow(time: number, query: string): void {
    logger.warn({ durationMs: time, sql: query }, 'slow database query');
  }
}
