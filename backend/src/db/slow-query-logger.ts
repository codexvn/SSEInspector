import { SimpleConsoleLogger } from 'typeorm';

/** 仅记录慢查询耗时与 SQL，避免大字段参数让日志本身阻塞 Recorder Worker。 */
export class SlowQueryLogger extends SimpleConsoleLogger {
  override logQuerySlow(time: number, query: string): void {
    console.warn(`[db] slow query ${time}ms: ${query}`);
  }
}
