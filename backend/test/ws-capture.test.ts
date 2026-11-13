/**
 * ws-capture lane 管理器测试：直接实例化管理器（注入收集型 hooks），
 * 投喂合成帧序列，断言翻译出的 capture.* 消息序列与字段。
 *
 * 覆盖：完整 turn 生命周期、隐式默认 lane、双 lane 并发交错、error 信封终态、
 * 连接中断的未完成 turn（下游/上游两种语义）、同 lane 重复 create、
 * 坏 JSON 帧与迟到信封的防御性跳过、response.steer 不记录、分片 create 重组。
 */
import assert from 'node:assert/strict';
import { createWsConnectionCapture } from '../src/recorder/ws-capture';
import type { CaptureMetadata, MainToRecorderMessage } from '../src/recorder/protocol';
import { buildFrame, clientJsonFrame, serverJsonFrame, OP_TEXT } from './ws-helpers';

function testMetadata(overrides: Partial<CaptureMetadata> = {}): CaptureMetadata {
  return {
    id: 'conn-1',
    startedAt: Date.now(),
    timestamp: new Date().toISOString(),
    method: 'WS',
    path: '/v1/responses',
    upstreamUrl: 'http://upstream.test/v1/responses',
    requestHeaders: { authorization: 'Bearer test' },
    apiType: 'openai',
    apiEndpoint: 'openai-responses',
    ...overrides,
  };
}

interface Harness {
  dispatched: MainToRecorderMessage[];
  rawLines: Map<string, string>;
  warnings: string[];
  feed(dir: 'request' | 'response', chunk: Buffer): void;
  close(reason: 'downstream_closed' | 'upstream_closed' | 'upstream_error', error?: string): void;
}

function createHarness(metadata: CaptureMetadata = testMetadata()): Harness {
  const dispatched: MainToRecorderMessage[] = [];
  const rawLines = new Map<string, string>();
  const warnings: string[] = [];
  const capture = createWsConnectionCapture(metadata, {
    dispatch: message => dispatched.push(message),
    appendRawResponseText: (turnId, line) => rawLines.set(turnId, (rawLines.get(turnId) ?? '') + line),
    warn: (_event, text) => warnings.push(text),
  });
  return {
    dispatched,
    rawLines,
    warnings,
    feed: (dir, chunk) => capture.feed(dir, chunk),
    close: (reason, error) => capture.close(reason, error),
  };
}

/** 提取消息序列的简写签名，便于断言 */
function signature(messages: MainToRecorderMessage[]): string[] {
  return messages.map(message => message.type.replace('capture.', ''));
}

function testFullTurnLifecycle(): void {
  const h = createHarness();
  h.feed('request', clientJsonFrame({ type: 'response.create', stream_id: 'lane-a', model: 'gpt-test', input: [] }));
  const turnId = 'conn-1:1';

  // turn 开启：start + create 原文作为请求体 + request_end + response_start(101, streaming)
  assert.deepEqual(signature(h.dispatched), ['start', 'request_chunk', 'request_end', 'response_start']);
  const start = h.dispatched[0];
  assert.ok(start.type === 'capture.start');
  assert.equal(start.metadata.streamId, 'lane-a');
  assert.equal(start.metadata.path, '/v1/responses');
  assert.equal(start.metadata.method, 'WS');
  assert.notEqual(start.metadata.id, 'conn-1');
  const responseStart = h.dispatched[3];
  assert.ok(responseStart.type === 'capture.response_start');
  assert.equal(responseStart.status, 101);
  assert.equal(responseStart.streaming, true);

  // 信封流：内层事件序列化为 SSE data 行
  h.dispatched.length = 0;
  h.feed('response', serverJsonFrame({ type: 'message', stream_id: 'lane-a', message: { type: 'response.created', response: { id: 'resp_1' } } }));
  h.feed('response', serverJsonFrame({ type: 'message', stream_id: 'lane-a', message: { type: 'response.output_text.delta', delta: 'hi' } }));
  h.feed('response', serverJsonFrame({ type: 'message', stream_id: 'lane-a', message: { type: 'response.completed', response: { id: 'resp_1', usage: {} } } }));
  assert.deepEqual(signature(h.dispatched), ['response_chunk', 'response_chunk', 'response_chunk', 'complete']);
  const chunk = h.dispatched[0];
  assert.ok(chunk.type === 'capture.response_chunk');
  assert.equal(chunk.id, turnId);
  assert.equal(Buffer.from(chunk.chunk).toString('utf8'), 'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
  // 原始信封按 NDJSON 行累积
  const raw = h.rawLines.get(turnId) ?? '';
  assert.equal(raw.split('\n').filter(Boolean).length, 3);
  assert.ok(raw.includes('"stream_id":"lane-a"'));
}

function testImplicitDefaultLane(): void {
  const h = createHarness();
  h.feed('request', clientJsonFrame({ type: 'response.create', model: 'gpt-test' }));
  const start = h.dispatched[0];
  assert.ok(start.type === 'capture.start');
  assert.equal(start.metadata.streamId, undefined);
  // 信封不携带 stream_id 时路由到默认 lane
  h.dispatched.length = 0;
  h.feed('response', serverJsonFrame({ type: 'message', message: { type: 'response.completed', response: {} } }));
  assert.deepEqual(signature(h.dispatched), ['response_chunk', 'complete']);
}

function testTwoLanesInterleaved(): void {
  const h = createHarness();
  h.feed('request', clientJsonFrame({ type: 'response.create', stream_id: 'a' }));
  h.feed('request', clientJsonFrame({ type: 'response.create', stream_id: 'b' }));
  h.dispatched.length = 0;
  h.feed('response', serverJsonFrame({ type: 'message', stream_id: 'b', message: { type: 'response.created' } }));
  h.feed('response', serverJsonFrame({ type: 'message', stream_id: 'a', message: { type: 'response.created' } }));
  h.feed('response', serverJsonFrame({ type: 'message', stream_id: 'b', message: { type: 'response.completed' } }));
  assert.deepEqual(signature(h.dispatched), ['response_chunk', 'response_chunk', 'response_chunk', 'complete']);
  assert.equal((h.dispatched[0] as { id: string }).id, 'conn-1:2');
  assert.equal((h.dispatched[2] as { id: string }).id, 'conn-1:2');
  assert.equal((h.dispatched[1] as { id: string }).id, 'conn-1:1');
  // lane a 仍未终态
  h.feed('response', serverJsonFrame({ type: 'message', stream_id: 'a', message: { type: 'response.completed' } }));
  const tail = h.dispatched[h.dispatched.length - 1];
  assert.ok(tail.type === 'capture.complete');
  assert.equal((tail as { id: string }).id, 'conn-1:1');
}

function testErrorEnvelopeTerminatesTurn(): void {
  const h = createHarness();
  h.feed('request', clientJsonFrame({ type: 'response.create', stream_id: 'x' }));
  h.dispatched.length = 0;
  h.feed('response', serverJsonFrame({ type: 'error', stream_id: 'x', status: 400, error: { type: 'invalid_request_error', code: 'bad' } }));
  assert.deepEqual(signature(h.dispatched), ['response_chunk', 'complete']);
  const chunk = h.dispatched[0];
  assert.ok(chunk.type === 'capture.response_chunk');
  const inner = JSON.parse((Buffer.from(chunk.chunk).toString('utf8')).replace(/^data: /, '').trim());
  assert.equal(inner.type, 'error');
  assert.equal(inner.error.code, 'bad');
  assert.ok((h.rawLines.get('conn-1:1') ?? '').includes('"type":"error"'));
}

function testConnectionCloseSemantics(): void {
  // 下游先关：未完成 turn 转译为 capture.closed
  const h1 = createHarness();
  h1.feed('request', clientJsonFrame({ type: 'response.create', stream_id: 'a' }));
  h1.dispatched.length = 0;
  h1.close('downstream_closed');
  assert.deepEqual(signature(h1.dispatched), ['closed']);
  assert.ok(h1.dispatched[0].type === 'capture.closed');
  assert.equal(h1.dispatched[0].reason, 'downstream_closed');

  // 上游错误：未完成 turn 转译为 capture.failed
  const h2 = createHarness();
  h2.feed('request', clientJsonFrame({ type: 'response.create' }));
  h2.dispatched.length = 0;
  h2.close('upstream_error', 'ECONNRESET');
  assert.deepEqual(signature(h2.dispatched), ['failed']);
  assert.ok(h2.dispatched[0].type === 'capture.failed');
  assert.equal(h2.dispatched[0].error, 'ECONNRESET');

  // 已全部终态的连接关闭不再产生消息
  const h3 = createHarness();
  h3.feed('request', clientJsonFrame({ type: 'response.create' }));
  h3.feed('response', serverJsonFrame({ type: 'message', message: { type: 'response.completed' } }));
  h3.dispatched.length = 0;
  h3.close('downstream_closed');
  assert.deepEqual(h3.dispatched, []);
}

function testDuplicateCreateOnSameLane(): void {
  const h = createHarness();
  h.feed('request', clientJsonFrame({ type: 'response.create', stream_id: 'a' }));
  h.dispatched.length = 0;
  h.feed('request', clientJsonFrame({ type: 'response.create', stream_id: 'a' }));
  // 旧 turn 按错误收尾，随后开启新 turn
  assert.deepEqual(signature(h.dispatched).slice(0, 2), ['failed', 'start']);
  assert.ok(h.dispatched[0].type === 'capture.failed');
  assert.equal(h.dispatched[0].id, 'conn-1:1');
  assert.ok(h.warnings.some(text => text.includes('新 response.create')));
}

function testDefensiveSkips(): void {
  const h = createHarness();
  // 坏 JSON 文本帧：跳过不抛
  h.feed('response', buildFrame(OP_TEXT, Buffer.from('not-json'), { mask: false }));
  assert.deepEqual(h.dispatched, []);
  assert.ok(h.warnings.some(text => text.includes('不是合法 JSON')));
  // steer 客户端事件不记录
  h.warnings.length = 0;
  h.feed('request', clientJsonFrame({ type: 'response.steer', previous_response_id: 'r', input: [] }));
  assert.deepEqual(h.dispatched, []);
  // 迟到信封（无进行中 turn）：跳过
  h.feed('response', serverJsonFrame({ type: 'message', stream_id: 'ghost', message: { type: 'response.created' } }));
  assert.ok(h.warnings.some(text => text.includes('没有对应进行中的 turn')));
}

function testFragmentedCreateEventReassembled(): void {
  const h = createHarness();
  const payload = Buffer.from(JSON.stringify({ type: 'response.create', stream_id: 'frag' }), 'utf8');
  const split = Math.floor(payload.length / 2);
  h.feed('request', buildFrame(OP_TEXT, payload.subarray(0, split), { fin: false, mask: true }));
  assert.deepEqual(h.dispatched, []);
  h.feed('request', buildFrame(0x0, payload.subarray(split), { mask: true }));
  assert.deepEqual(signature(h.dispatched), ['start', 'request_chunk', 'request_end', 'response_start']);
}

/** 原生 Responses WS 协议：服务端帧本身即事件（无 message 信封包装），按最近活跃 turn 归属 */
function testNativeResponsesEvents(): void {
  const h = createHarness();
  h.feed('request', clientJsonFrame({ type: 'response.create', model: 'gpt-test', input: [] }));
  const turnId = 'conn-1:1';

  h.dispatched.length = 0;
  h.feed('response', serverJsonFrame({ type: 'response.created', response: { id: 'resp_n1' } }));
  h.feed('response', serverJsonFrame({ type: 'response.output_text.delta', delta: '原生' }));
  h.feed('response', serverJsonFrame({ type: 'response.completed', response: { id: 'resp_n1', usage: {} } }));
  assert.deepEqual(signature(h.dispatched), ['response_chunk', 'response_chunk', 'response_chunk', 'complete']);
  const chunk = h.dispatched[0];
  assert.ok(chunk.type === 'capture.response_chunk');
  assert.equal(chunk.id, turnId);
  assert.equal(Buffer.from(chunk.chunk).toString('utf8'), 'data: {"type":"response.created","response":{"id":"resp_n1"}}\n\n');
  assert.equal(h.warnings.length, 0, '原生事件应被正常归属而非告警跳过');

  // turn 终态后，连接保持期间的迟到原生事件：无归属 turn，告警跳过
  h.dispatched.length = 0;
  h.feed('response', serverJsonFrame({ type: 'response.output_text.delta', delta: 'late' }));
  assert.deepEqual(signature(h.dispatched), []);
  assert.ok(h.warnings.some(text => text.includes('没有对应进行中的 turn')));
}

/** 信封 lane 学习：客户端 create 未带 stream_id、服务端信封补全时，重挂 lane 键后续路由正确 */
function testEnvelopeLaneLearning(): void {
  const h = createHarness();
  h.feed('request', clientJsonFrame({ type: 'response.create', model: 'gpt-test' }));
  const turnId = 'conn-1:1';

  // 服务端信封带了服务端分配的 stream_id：应归属隐式默认 turn 并学习映射
  h.dispatched.length = 0;
  h.feed('response', serverJsonFrame({ type: 'message', stream_id: 'server-lane-9', message: { type: 'response.created', response: { id: 'resp_s' } } }));
  assert.deepEqual(signature(h.dispatched), ['response_chunk']);

  // 后续同 stream_id 信封正常路由；终态收尾
  h.dispatched.length = 0;
  h.feed('response', serverJsonFrame({ type: 'message', stream_id: 'server-lane-9', message: { type: 'response.completed', response: { id: 'resp_s', usage: {} } } }));
  assert.deepEqual(signature(h.dispatched), ['response_chunk', 'complete']);
  assert.equal(h.dispatched[1].type === 'capture.complete' ? h.dispatched[1].id : '', turnId);
  assert.equal(h.warnings.length, 0);
}

/** 未知服务端帧类型：告警跳过（不再静默） */
function testUnknownServerFrameWarns(): void {
  const h = createHarness();
  h.feed('request', clientJsonFrame({ type: 'response.create', model: 'gpt-test' }));
  h.dispatched.length = 0;
  h.feed('response', serverJsonFrame({ type: 'something.else', payload: 1 }));
  assert.deepEqual(signature(h.dispatched), []);
  assert.ok(h.warnings.some(text => text.includes('未知 WS 服务端帧类型')));
}

function main(): void {
  testFullTurnLifecycle();
  testImplicitDefaultLane();
  testTwoLanesInterleaved();
  testErrorEnvelopeTerminatesTurn();
  testConnectionCloseSemantics();
  testDuplicateCreateOnSameLane();
  testDefensiveSkips();
  testFragmentedCreateEventReassembled();
  testNativeResponsesEvents();
  testEnvelopeLaneLearning();
  testUnknownServerFrameWarns();
  console.log('ws-capture tests passed');
}

main();
