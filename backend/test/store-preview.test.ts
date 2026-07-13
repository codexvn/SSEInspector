import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig } from '../src/config';
import type { ApiEndpoint, RecordedRequest } from '../src/types';

function request(id: string, requestBody: Record<string, unknown>, apiEndpoint: ApiEndpoint, error?: string): RecordedRequest {
  const endpoint = {
    'openai-chat': { path: '/v1/chat/completions', apiType: 'openai' as const },
    'openai-responses': { path: '/v1/responses', apiType: 'openai' as const },
    'anthropic-messages': { path: '/v1/messages', apiType: 'anthropic' as const },
  }[apiEndpoint];
  return {
    id,
    timestamp: new Date().toISOString(),
    method: 'POST',
    path: endpoint.path,
    upstreamUrl: 'http://upstream.test',
    requestHeaders: {},
    requestBody,
    responseStatus: 200,
    responseContent: null,
    streaming: false,
    durationMs: 1,
    apiType: endpoint.apiType,
    apiEndpoint,
    state: error ? 'error' : 'done',
    error,
  };
}

async function main(): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'sse-inspector-preview-'));
  const dbPath = join(tempDir, 'test.db');
  setConfig({ upstreamUrl: 'http://upstream.test', port: 0, dbPath });

  const [{ AppDataSource, initDb }, { getAll, getToolCalls, upsertRecord, updateToolCallResults, writeToolCalls }] = await Promise.all([
    import('../src/db'),
    import('../src/store'),
  ]);

  try {
    await initDb();

    await upsertRecord(request('with-user', {
      model: 'gpt-test',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '本轮用户问题' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '历史 assistant 内容' }] },
        { type: 'function_call_output', call_id: 'call_1', output: '工具结果' },
      ],
    }, 'openai-responses'));

    await upsertRecord(request('without-user', {
      model: 'gpt-test',
      input: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '不应作为 preview 的 assistant 内容' }],
        },
        { type: 'function_call_output', call_id: 'call_2', output: '工具结果' },
      ],
    }, 'openai-responses', '请求失败'));

    await upsertRecord(request('messages-user', {
      model: 'gpt-test',
      messages: [
        { role: 'assistant', content: '历史 assistant 内容' },
        { role: 'user', content: 'Chat 用户问题' },
      ],
    }, 'openai-chat'));

    await upsertRecord(request('multi-block-developer', {
      model: 'gpt-test',
      input: [
        { type: 'message', role: 'developer', content: [
          { type: 'input_text', text: '第一段' },
          { type: 'input_text', text: '第二段' },
        ] },
      ],
    }, 'openai-responses'));

    await upsertRecord(request('tool-only', {
      model: 'gpt-test',
      input: [{ type: 'custom_tool_call_output', call_id: 'call_3', output: { ok: true } }],
    }, 'openai-responses'));

    await upsertRecord(request('body-error', {
      model: 'gpt-test',
      input: [],
      error: { code: 'bad_request', message: '请求体错误' },
    }, 'openai-responses'));

    const result = await getAll(1, 10);
    assert.equal(typeof result, 'object');
    const items = (result as { items: Array<{ id: string; preview: string }> }).items;
    assert.equal(items.find(item => item.id === 'with-user')?.preview, '历史 assistant 内容');
    assert.equal(items.find(item => item.id === 'without-user')?.preview, '不应作为 preview 的 assistant 内容');
    assert.equal(items.find(item => item.id === 'messages-user')?.preview, 'Chat 用户问题');
    assert.equal(items.find(item => item.id === 'multi-block-developer')?.preview, '第一段\n第二段');
    assert.equal(items.find(item => item.id === 'tool-only')?.preview, '{"ok":true}');
    assert.equal(items.find(item => item.id === 'body-error')?.preview, '请求体错误');

    await writeToolCalls('with-user', [
      { tool_call_id: 'call-a', tool_name: 'same-name', arguments: '{"a":1}' },
      { tool_call_id: 'call-b', tool_name: 'same-name', arguments: '{"b":2}' },
    ]);
    await updateToolCallResults([{ tool_call_id: 'call-b', result: '{"ok":true}' }]);
    const persistedTools = await getToolCalls('with-user');
    assert.equal(persistedTools.find(tool => tool.tool_call_id === 'call-a')?.result, undefined);
    assert.equal(persistedTools.find(tool => tool.tool_call_id === 'call-b')?.result, '{"ok":true}');

  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('store preview tests passed');
}).catch((error: unknown) => {
  console.error(`store preview tests failed: ${formatErrorChain(error)}`);
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
