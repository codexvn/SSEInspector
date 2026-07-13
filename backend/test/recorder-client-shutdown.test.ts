import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig } from '../src/config';
import { recorderAvailable, recorderRpc, startRecorder, stopRecorder } from '../src/recorder/client';

async function main(): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'sse-inspector-recorder-shutdown-'));
  setConfig({ upstreamUrl: 'http://127.0.0.1:1', port: 0, dbPath: join(tempDir, 'test.db') });

  try {
    await startRecorder();
    assert.equal(recorderAvailable(), true);

    const startedAt = Date.now();
    const stopping = stopRecorder(2000);
    assert.equal(recorderAvailable(), false, '进入关闭流程后必须立即停止接受新任务');
    await assert.rejects(() => recorderRpc('requests.stats'), /不可用/);
    await stopping;
    assert.ok(Date.now() - startedAt < 2500, '关闭时间不得超过给定总时限');
  } finally {
    await stopRecorder(2000);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('recorder client shutdown tests passed');
}).catch(error => {
  console.error(`recorder client shutdown tests failed: ${formatErrorChain(error)}`);
  process.exitCode = 1;
});

function formatErrorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current) {
    if (current instanceof Error) {
      messages.push(`${current.name}: ${current.message}`);
      current = current.cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  return messages.join(' -> ');
}
