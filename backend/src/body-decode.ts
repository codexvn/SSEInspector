/**
 * 请求体解码纯函数模块。
 *
 * 透明代理透传的是原始字节（含 content-encoding），检查器（记录 / token 统计 / 工具回填）
 * 需要一份「解压 + JSON.parse」后的副本。本模块只做解码，不依赖 Express / DB，便于单测。
 *
 * 设计原则：解码失败只返回 error，绝不抛出——检查器功能降级，绝不阻塞代理透传。
 * 详见 CLAUDE.md「保持代理透明」与 proxy.ts readRawBody。
 */

import * as zlib from 'node:zlib';

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
        // zstd 在 Node 22.15+ / 24+ 可用；低版本（package.json engines 写 >=18）降级，不阻塞透传
        if (typeof zlib.zstdDecompressSync !== 'function') {
          return { ok: false, error: `当前 Node 运行时不支持 zstd 解压: ${contentEncoding}` };
        }
        return { ok: true, buffer: zlib.zstdDecompressSync(buf) };
      default:
        return { ok: false, error: `未知的 content-encoding: ${contentEncoding}` };
    }
  } catch (e) {
    return { ok: false, error: `解压失败 (${enc}): ${(e as Error).message}` };
  }
}

/** 解码请求体结果：parsed 为解码后的对象；error 表示解码失败（检查器降级） */
export type DecodeResult = { parsed?: unknown; error?: string };

/**
 * 解码请求体供检查器使用：先按 content-encoding 解压，再 JSON.parse。
 * 任一步失败返回 { error }，不抛。空 body 返回 {}（无 parsed 无 error）。
 */
export function decodeRequestBody(buf: Buffer, contentEncoding: string | undefined): DecodeResult {
  if (buf.length === 0) return {};
  const decompressed = decompressBuffer(buf, contentEncoding);
  if (!decompressed.ok) return { error: decompressed.error };
  try {
    return { parsed: JSON.parse(decompressed.buffer.toString('utf-8')) };
  } catch (e) {
    return { error: `请求体 JSON 解析失败: ${(e as Error).message}` };
  }
}
