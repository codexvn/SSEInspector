import assert from 'node:assert/strict';
import { SlowQueryLogger } from '../src/db/slow-query-logger';

function testSlowQueryOnlyLogsSqlAndElapsedTime(): void {
  const messages: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => {
    messages.push(values.map(String).join(' '));
  };

  try {
    const logger = new SlowQueryLogger();
    logger.logQuerySlow(
      327,
      'UPDATE requests SET response_body = ? WHERE id = ?',
      ['large-response-body', 'request-id'],
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(messages, [
    '[db] slow query 327ms: UPDATE requests SET response_body = ? WHERE id = ?',
  ]);
  assert.doesNotMatch(messages[0] ?? '', /large-response-body|request-id/);
}

testSlowQueryOnlyLogsSqlAndElapsedTime();

console.log('db logger tests passed');
