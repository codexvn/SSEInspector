/**
 * WebSocket 测试共享助手：手工构造协议帧。
 * 服务端→客户端帧不掩码（RFC 6455），客户端→服务端帧传 mask: true。
 */

export function buildFrame(
  opcode: number,
  payload: Buffer,
  options: { fin?: boolean; mask?: boolean } = {},
): Buffer {
  const fin = options.fin ?? true;
  const mask = options.mask ?? false;
  const finBit = fin ? 0x80 : 0x0;
  const maskBit = mask ? 0x80 : 0x0;

  let lengthBytes: number[];
  if (payload.length < 126) {
    lengthBytes = [payload.length];
  } else if (payload.length <= 0xffff) {
    lengthBytes = [126, payload.length >> 8, payload.length & 0xff];
  } else {
    const big = BigInt(payload.length);
    lengthBytes = [127];
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      lengthBytes.push(Number((big >> shift) & 0xffn));
    }
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

export const OP_TEXT = 0x1;
export const OP_CLOSE = 0x8;

/** 构造一个客户端→服务端的掩码文本帧（JSON 事件） */
export function clientJsonFrame(event: unknown): Buffer {
  return buildFrame(OP_TEXT, Buffer.from(JSON.stringify(event), 'utf8'), { mask: true });
}

/** 构造一个服务端→客户端的未掩码文本帧（JSON 信封） */
export function serverJsonFrame(envelope: unknown): Buffer {
  return buildFrame(OP_TEXT, Buffer.from(JSON.stringify(envelope), 'utf8'));
}
