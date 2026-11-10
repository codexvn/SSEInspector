/**
 * ws-frames 帧解析器纯函数测试。
 *
 * 覆盖：未掩码/掩码帧、7/16/64 位长度、分片投喂（头/扩展长度/掩码/载荷逐段截断）、
 * 分片消息重组、ping/pong/close 观察、协议错误（RSV、孤立 continuation、分片控制帧）
 * 与一次投喂多帧。
 */
import assert from 'node:assert/strict';
import {
  createWebSocketFrameParser,
  WS_OPCODE_TEXT,
  WS_OPCODE_BINARY,
  WS_OPCODE_CLOSE,
  WS_OPCODE_PING,
  WS_OPCODE_PONG,
  WS_OPCODE_CONTINUATION,
  type WsFrame,
} from '../src/recorder/ws-frames';

/** 构造一个 WebSocket 帧（测试用）：服务端帧默认不掩码，客户端帧传 mask=true */
function buildFrame(
  opcode: number,
  payload: Buffer,
  options: { fin?: boolean; mask?: boolean } = {},
): Buffer {
  const fin = options.fin ?? true;
  const mask = options.mask ?? false;
  const finBit = fin ? 0x80 : 0x0;
  const maskBit = mask ? 0x80 : 0x0;

  let lengthBytes: number[] = [];
  if (payload.length < 126) {
    lengthBytes = [payload.length];
  } else if (payload.length <= 0xffff) {
    lengthBytes = [126, payload.length >> 8, payload.length & 0xff];
  } else {
    const big = BigInt(payload.length);
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      lengthBytes.push(Number((big >> shift) & 0xffn));
    }
    lengthBytes.unshift(127);
  }

  const maskKey = mask ? Buffer.from([0x11, 0x22, 0x33, 0x44]) : null;
  const body = mask
    ? Buffer.from(payload.map((byte, i) => byte ^ maskKey[i & 3]))
    : payload;

  return Buffer.concat([
    Buffer.from([finBit | opcode, maskBit | lengthBytes[0], ...lengthBytes.slice(1)]),
    maskKey ?? Buffer.alloc(0),
    body,
  ]);
}

function textPayload(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

function collect(frames: WsFrame[]): string[] {
  return frames.map(frame =>
    frame.opcode === WS_OPCODE_TEXT || frame.opcode === WS_OPCODE_BINARY
      ? `data:${frame.payload.toString('utf8')}`
      : `${frame.opcode}:${JSON.stringify(frame)}`,
  );
}

function testSingleUnmaskedTextFrame(): void {
  const parser = createWebSocketFrameParser();
  const frames = parser.push(buildFrame(WS_OPCODE_TEXT, textPayload('hello')));
  assert.deepEqual(collect(frames), ['data:hello']);
}

function testMaskedClientFrameUnmasked(): void {
  const parser = createWebSocketFrameParser();
  const frames = parser.push(buildFrame(WS_OPCODE_TEXT, textPayload('{"type":"response.create"}'), { mask: true }));
  assert.deepEqual(collect(frames), ['data:{"type":"response.create"}']);
}

function testPartialFeedAcrossHeaderLengthMaskPayload(): void {
  const parser = createWebSocketFrameParser();
  const bytes = buildFrame(WS_OPCODE_TEXT, textPayload('0123456789'), { mask: true });
  // 逐字节投喂：覆盖头部、扩展字段、掩码、载荷任意位置截断
  const collected: string[] = [];
  for (const byte of bytes) collected.push(...collect(parser.push(Buffer.from([byte]))));
  assert.deepEqual(collected, ['data:0123456789']);
}

function testExtendedLength16(): void {
  const parser = createWebSocketFrameParser();
  const payload = Buffer.alloc(300, 0x61);
  const frames = parser.push(buildFrame(WS_OPCODE_BINARY, payload));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, WS_OPCODE_BINARY);
  if (frames[0].opcode === WS_OPCODE_BINARY) assert.equal(frames[0].payload.length, 300);
}

function testExtendedLength64(): void {
  const parser = createWebSocketFrameParser();
  const payload = Buffer.alloc(70000, 0x62);
  const frames = parser.push(buildFrame(WS_OPCODE_TEXT, payload));
  assert.equal(frames.length, 1);
  if (frames[0].opcode === WS_OPCODE_TEXT) assert.equal(frames[0].payload.length, 70000);
}

function testFragmentedMessageReassembled(): void {
  const parser = createWebSocketFrameParser();
  assert.deepEqual(collect(parser.push(buildFrame(WS_OPCODE_TEXT, textPayload('{"a"'), { fin: false, mask: true }))), []);
  assert.deepEqual(collect(parser.push(buildFrame(WS_OPCODE_CONTINUATION, textPayload(':1,'), { fin: false, mask: true }))), []);
  const frames = parser.push(buildFrame(WS_OPCODE_CONTINUATION, textPayload('"b":2}'), { mask: true }));
  assert.deepEqual(collect(frames), ['data:{"a":1,"b":2}']);
}

function testControlFramesObserved(): void {
  const parser = createWebSocketFrameParser();
  const ping = parser.push(buildFrame(WS_OPCODE_PING, textPayload('tick')));
  assert.equal(ping.length, 1);
  assert.equal(ping[0].opcode, WS_OPCODE_PING);
  if (ping[0].opcode === WS_OPCODE_PING) assert.equal(ping[0].payload.toString('utf8'), 'tick');

  const pong = parser.push(buildFrame(WS_OPCODE_PONG, Buffer.alloc(0)));
  assert.equal(pong.length, 1);
  assert.equal(pong[0].opcode, WS_OPCODE_PONG);

  const close = parser.push(buildFrame(WS_OPCODE_CLOSE, Buffer.concat([Buffer.from([0x03, 0xe8]), textPayload('done')])));
  assert.equal(close.length, 1);
  const closeFrame = close[0];
  assert.equal(closeFrame.opcode, WS_OPCODE_CLOSE);
  if (closeFrame.opcode === WS_OPCODE_CLOSE) {
    assert.equal(closeFrame.code, 1000);
    assert.equal(closeFrame.reason, 'done');
  }
}

function testProtocolErrorsReportedAndSkipped(): void {
  const errors: string[] = [];
  const parser = createWebSocketFrameParser({ onProtocolError: message => errors.push(message) });

  // RSV1 置位：帧被丢弃，后续正常帧仍可解析
  const bad = Buffer.concat([Buffer.from([0x80 | 0x40 | WS_OPCODE_TEXT, 0x02]), textPayload('zz')]);
  const afterBad = parser.push(Buffer.concat([bad, buildFrame(WS_OPCODE_TEXT, textPayload('ok'))]));
  assert.deepEqual(collect(afterBad), ['data:ok']);

  // 孤立 continuation：丢弃且不影响后续
  const stray = parser.push(Buffer.concat([
    buildFrame(WS_OPCODE_CONTINUATION, textPayload('x'), { mask: true }),
    buildFrame(WS_OPCODE_TEXT, textPayload('fine')),
  ]));
  assert.deepEqual(collect(stray), ['data:fine']);
  assert.equal(errors.length, 2);
}

function testMultipleFramesInOnePush(): void {
  const parser = createWebSocketFrameParser();
  const bytes = Buffer.concat([
    buildFrame(WS_OPCODE_TEXT, textPayload('one'), { mask: true }),
    buildFrame(WS_OPCODE_PING, Buffer.alloc(0)),
    buildFrame(WS_OPCODE_TEXT, textPayload('two')),
  ]);
  const frames = parser.push(bytes);
  assert.deepEqual(collect(frames.filter(f => f.opcode !== WS_OPCODE_PING)), ['data:one', 'data:two']);
  const pingFrame = frames.find(f => f.opcode === WS_OPCODE_PING);
  assert.ok(pingFrame);
  if (pingFrame.opcode === WS_OPCODE_PING) assert.equal(pingFrame.payload.length, 0);
}

function testEmptyPushReturnsNothing(): void {
  const parser = createWebSocketFrameParser();
  assert.deepEqual(parser.push(Buffer.alloc(0)), []);
}

function main(): void {
  testSingleUnmaskedTextFrame();
  testMaskedClientFrameUnmasked();
  testPartialFeedAcrossHeaderLengthMaskPayload();
  testExtendedLength16();
  testExtendedLength64();
  testFragmentedMessageReassembled();
  testControlFramesObserved();
  testProtocolErrorsReportedAndSkipped();
  testMultipleFramesInOnePush();
  testEmptyPushReturnsNothing();
  console.log('ws-frames tests passed');
}

main();
