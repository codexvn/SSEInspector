/**
 * 请求体解码纯函数模块。
 *
 * 透明代理透传的是原始字节（含 content-encoding），检查器（记录 / preview / 工具回填）
 * 需要一份「解压 + JSON.parse」后的副本。本模块只做解码，不依赖 Express / DB，便于单测。
 *
 * 设计原则：解码失败只返回 error，绝不抛出——检查器功能降级，绝不阻塞代理透传。
 * 该函数只在 Recorder Worker 中处理旁路捕获副本，主线程不调用。
 */

import * as zlib from 'node:zlib';
import { formatErrorChain, getLogger, serializeError } from './logger';

const logger = getLogger('body-decode');

/** 解压结果：成功返回 buffer，失败返回 error（不抛） */
export type DecompressResult = { ok: true; buffer: Buffer } | { ok: false; error: string };

/**
 * 按单一 Content-Encoding header 解压。
 *
 * 解法仅依赖这一个头。支持单编码 identity / gzip / deflate / br / zstd；
 * 多值（含逗号）或未知编码降级为 { ok: false, error }，不抛、不阻塞透传。
 *
 * 不做多编码逐层解压——真实请求体流量中多值嵌套几乎为零（OpenAI / Anthropic SDK 发 zstd 即单值），
 * 为不存在的场景写逐层解压属于过度设计。
 */
export function decompressBuffer(buf: Buffer, contentEncoding: string | undefined): DecompressResult {
  const enc = (contentEncoding ?? '').trim().toLowerCase();
  if (enc === '' || enc === 'identity') return { ok: true, buffer: buf };
  if (enc.includes(',')) {
    return { ok: false, error: `不支持的多值 content-encoding: ${contentEncoding}` };
  }
  try {
    switch (enc) {
      case 'gzip':
        return { ok: true, buffer: zlib.gunzipSync(buf) };
      case 'deflate':
        return { ok: true, buffer: zlib.inflateSync(buf) };
      case 'br':
        return { ok: true, buffer: zlib.brotliDecompressSync(buf) };
      case 'zstd':
        // zstd 仅在部分 Node 20+ 运行时可用；不支持时降级，不阻塞透传
        if (typeof zlib.zstdDecompressSync !== 'function') {
          return { ok: false, error: `当前 Node 运行时不支持 zstd 解压: ${contentEncoding}` };
        }
        return { ok: true, buffer: zlib.zstdDecompressSync(buf) };
      default:
        return { ok: false, error: `未知的 content-encoding: ${contentEncoding}` };
    }
  } catch (e) {
    const error = `解压失败 (${enc}): ${formatErrorChain(e)}`;
    logger.warn({ encoding: enc, err: serializeError(e) }, 'request body decompression failed');
    return { ok: false, error };
  }
}

/** 解码请求体结果：parsed 为解码后的对象；error 表示解码失败（检查器降级） */
export type DecodeResult = { parsed?: unknown; error?: string };

/**
 * 解码请求体供检查器使用：先按 content-encoding 解压，再 JSON.parse。
 * JSON 失败且 buffer 为有效 UTF-8 时回退为文本字符串；二进制仍 { error }。
 * 任一步失败返回 { error }，不抛。空 body 返回 {}（无 parsed 无 error）。
 */
export function decodeRequestBody(buf: Buffer, contentEncoding: string | undefined): DecodeResult {
  if (buf.length === 0) return {};
  const decompressed = decompressBuffer(buf, contentEncoding);
  if (!decompressed.ok) return { error: decompressed.error };
  try {
    return { parsed: JSON.parse(decompressed.buffer.toString('utf-8')) };
  } catch (e) {
    const text = decompressed.buffer.toString('utf8');
    // Buffer 与 utf8 round-trip 一致则视为文本
    if (Buffer.from(text, 'utf8').equals(decompressed.buffer)) {
      return { parsed: text };
    }
    const error = `请求体 JSON 解析失败: ${formatErrorChain(e)}`;
    logger.warn({ err: serializeError(e) }, 'request body JSON parsing failed');
    return { error };
  }
}
