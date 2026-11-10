/**
 * WebSocket 帧解析器（纯函数模块，无任何 IO 依赖）。
 *
 * 职责定位：主线程对 WS 连接只做原始字节 tee（与 HTTP 数据面的 body tee 对称），
 * 帧边界切分、掩码解除、分片重组全部在 Recorder Worker 内由本模块完成。
 *
 * 前提约束：升级请求进入代理时已剥离 sec-websocket-extensions 请求头
 * （permessage-deflate 是逐跳扩展，代理逐跳重协商在 RFC 7692 语义内合法），
 * 因此两个方向都不会出现压缩帧；RSV 位非零即视为协议错误。
 * 控制帧（ping/pong/close）仅做观察提取，字节层由 httpxy 管道原样透传，
 * 本模块不产生任何转发动作。
 */

export const WS_OPCODE_CONTINUATION = 0x0;
export const WS_OPCODE_TEXT = 0x1;
export const WS_OPCODE_BINARY = 0x2;
export const WS_OPCODE_CLOSE = 0x8;
export const WS_OPCODE_PING = 0x9;
export const WS_OPCODE_PONG = 0xa;

/** 观察到的数据帧（文本/二进制），payload 已解除掩码；分片消息在 fin 时合并交付 */
export interface WsDataFrame {
  opcode: typeof WS_OPCODE_TEXT | typeof WS_OPCODE_BINARY;
  fin: true;
  payload: Buffer;
}

/** close 帧：code 与 reason 按 RFC 6455 5.5.1 提取，payload 不足 2 字节时两者皆缺省 */
export interface WsCloseFrame {
  opcode: typeof WS_OPCODE_CLOSE;
  code?: number;
  reason?: string;
}

/** ping/pong 帧：仅观察，不携带语义动作 */
export interface WsControlFrame {
  opcode: typeof WS_OPCODE_PING | typeof WS_OPCODE_PONG;
  payload: Buffer;
}

export type WsFrame = WsDataFrame | WsCloseFrame | WsControlFrame;

export interface WsFrameParser {
  /**
   * 投喂一段原始字节，返回其中完整解析出的帧（可能为空数组）。
   * 不完整的帧在内部缓冲，等待后续投喂补齐；协议错误按帧丢弃并经
   * onProtocolError 上报，不抛出（调用方位于 Worker 消息链，抛错即 fatal）。
   */
  push(bytes: Uint8Array): WsFrame[];
}

/** 单帧字节数上限：防御性护栏，正常 Responses 事件帧远小于该值 */
const MAX_FRAME_BYTES = 256 * 1024 * 1024;

export function createWebSocketFrameParser(options?: {
  onProtocolError?: (message: string) => void;
}): WsFrameParser {
  const reportError = options?.onProtocolError ?? (() => {});
  let buffer = Buffer.alloc(0);
  // 分片重组状态：正在累积的未完成消息（opcode 为首帧 opcode，parts 为已到分片）
  let messageOpcode: number | null = null;
  let messageParts: Buffer[] = [];

  function push(bytes: Uint8Array): WsFrame[] {
    if (bytes.length > 0) {
      buffer = buffer.length === 0 ? Buffer.from(bytes) : Buffer.concat([buffer, Buffer.from(bytes)]);
    }
    const frames: WsFrame[] = [];
    for (;;) {
      const frame = tryParseFrame();
      if (!frame) break;
      const delivered = consumeFrame(frame);
      if (delivered) frames.push(delivered);
    }
    return frames;
  }

  /** 尝试从缓冲头部解析一个帧；字节不足时返回 null 且不动缓冲 */
  function tryParseFrame(): ParsedFrame | null {
    if (buffer.length < 2) return null;
    const b0 = buffer[0];
    const b1 = buffer[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buffer.length < offset + 2) return null;
      length = buffer.readUInt16BE(offset);
      offset += 2;
      if (length < 126) reportError(`16 位长度编码携带了非法小值 ${length}`);
    } else if (length === 127) {
      if (buffer.length < offset + 8) return null;
      const big = buffer.readBigUInt64BE(offset);
      offset += 8;
      if (big > BigInt(MAX_FRAME_BYTES)) {
        reportError(`帧长度 ${big} 超过护栏上限，丢弃后续全部缓冲`);
        buffer = Buffer.alloc(0);
        resetFragmentation();
        return null;
      }
      length = Number(big);
    }

    const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (buffer.length < offset + length) return null;

    let payload = Buffer.from(buffer.subarray(offset, offset + length));
    buffer = buffer.subarray(offset + length);
    if (maskKey) {
      // 客户端→服务端帧必带掩码；XOR 解除后即为明文载荷
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    if (rsv !== 0) {
      // 压缩扩展已在入口剥离，RSV 非零说明对端未遵守协商。
      // 必须完整消费该帧（含载荷）后再丢弃，否则残留字节会使后续解析失步。
      reportError(`RSV 位非零（rsv=0x${rsv.toString(16)}），丢弃 1 帧`);
      return { opcode, fin, masked, payload: Buffer.alloc(0), dropped: true };
    }
    return { opcode, fin, masked, payload, dropped: false };
  }

  /** 控制帧直接交付；数据帧处理分片重组，完整消息（fin）才对外交付 */
  function consumeFrame(frame: ParsedFrame): WsFrame | null {
    if (frame.dropped) return null;
    if (frame.opcode >= 0x8) {
      if (!frame.fin) {
        reportError('控制帧不允许分片，丢弃该帧');
        return null;
      }
      if (frame.payload.length > 125) {
        reportError('控制帧载荷超过 125 字节，丢弃该帧');
        return null;
      }
      if (frame.opcode === WS_OPCODE_CLOSE) {
        if (frame.payload.length === 0) return { opcode: WS_OPCODE_CLOSE };
        const code = frame.payload.readUInt16BE(0);
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : undefined;
        return { opcode: WS_OPCODE_CLOSE, code, reason };
      }
      return { opcode: frame.opcode as WsControlFrame['opcode'], payload: frame.payload };
    }

    if (frame.opcode === WS_OPCODE_CONTINUATION) {
      if (messageOpcode === null) {
        reportError('continuation 帧没有对应的数据帧在途，丢弃该帧');
        return null;
      }
      messageParts.push(frame.payload);
      if (frame.fin) return assembleMessage();
      return null;
    }

    // 新数据帧（text/binary）
    if (messageOpcode !== null) {
      reportError('上一条分片消息未结束时收到新数据帧，丢弃新帧并放弃未完成消息');
      resetFragmentation();
      return null;
    }
    if (frame.fin) {
      return { opcode: frame.opcode as WsDataFrame['opcode'], fin: true, payload: frame.payload };
    }
    messageOpcode = frame.opcode;
    messageParts = [frame.payload];
    return null;
  }

  function assembleMessage(): WsFrame | null {
    const opcode = messageOpcode as WsDataFrame['opcode'];
    const payload = messageParts.length === 1 ? messageParts[0] : Buffer.concat(messageParts);
    resetFragmentation();
    return { opcode, fin: true, payload };
  }

  function resetFragmentation(): void {
    messageOpcode = null;
    messageParts = [];
  }

  return { push };
}

interface ParsedFrame {
  opcode: number;
  fin: boolean;
  masked: boolean;
  payload: Buffer;
  dropped: boolean;
}
