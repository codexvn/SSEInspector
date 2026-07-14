import assert from 'node:assert/strict';
import { SlowQueryLogger } from '../src/db/slow-query-logger';
import { getLogger } from '../src/logger';

function testSlowQueryOnlyLogsSqlAndElapsedTime(): void {
  const dbLogger = getLogger('db');
  const originalWarn = dbLogger.warn;
  let captured: { fields: Record<string, unknown>; message: string } | undefined;
  dbLogger.warn = ((fields: Record<string, unknown>, message: string) => {
    captured = { fields, message };
  }) as typeof dbLogger.warn;

  try {
    const logger = new SlowQueryLogger();
    logger.logQuerySlow(
      327,
      'UPDATE requests SET response_body = ? WHERE id = ?',
      ['large-response-body', 'request-id'],
    );
  } finally {
    dbLogger.warn = originalWarn;
  }

  assert.deepEqual(captured, {
    fields: {
      durationMs: 327,
      sql: 'UPDATE requests SET response_body = ? WHERE id = ?',
    },
    message: 'slow database query',
  });
  assert.doesNotMatch(JSON.stringify(captured), /large-response-body|request-id/);
}

testSlowQueryOnlyLogsSqlAndElapsedTime();

console.log('db logger tests passed');
