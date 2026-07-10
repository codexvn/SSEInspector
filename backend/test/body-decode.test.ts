import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import { decompressBuffer, decodeRequestBody } from '../src/body-decode';

// 请求体解码纯函数测试。运行：tsx backend/test/body-decode.test.ts

const PARSED = { stream: true, model: 'gpt' };
const JSON_BUF = Buffer.from(JSON.stringify(PARSED), 'utf-8');

/** 取解压成功分支的 buffer，失败则抛（测试辅助）。用 ReturnType 推断避免额外 import type */
function bufferOf(r: ReturnType<typeof decompressBuffer>): Buffer {
  if (!r.ok) throw new Error(`预期解压成功，实际失败: ${r.error}`);
  return r.buffer;
}

// zstd 压缩 API 仅 Node 22.15+ / 24+ 可用；低版本运行时跳过 zstd 相关用例（用 as 规避类型差异）
const zstdCompressSync = (zlib as { zstdCompressSync?: (buf: Buffer) => Buffer }).zstdCompressSync;
const hasZstd = typeof zstdCompressSync === 'function';

function testIdentity(): void {
  assert.ok(bufferOf(decompressBuffer(JSON_BUF, undefined)).equals(JSON_BUF));
  assert.ok(bufferOf(decompressBuffer(JSON_BUF, '')).equals(JSON_BUF));
  assert.ok(bufferOf(decompressBuffer(JSON_BUF, 'identity')).equals(JSON_BUF));

  const r = decodeRequestBody(JSON_BUF, undefined);
  assert.deepEqual(r.parsed, PARSED);
  assert.equal(r.error, undefined);
}

function testGzip(): void {
  const c = zlib.gzipSync(JSON_BUF);
  assert.ok(bufferOf(decompressBuffer(c, 'gzip')).equals(JSON_BUF));
  assert.deepEqual(decodeRequestBody(c, 'gzip').parsed, PARSED);
}

function testDeflate(): void {
  const c = zlib.deflateSync(JSON_BUF);
  assert.ok(bufferOf(decompressBuffer(c, 'deflate')).equals(JSON_BUF));
  assert.deepEqual(decodeRequestBody(c, 'deflate').parsed, PARSED);
}

function testBrotli(): void {
  const c = zlib.brotliCompressSync(JSON_BUF);
  assert.ok(bufferOf(decompressBuffer(c, 'br')).equals(JSON_BUF));
  assert.deepEqual(decodeRequestBody(c, 'br').parsed, PARSED);
}

function testZstd(): void {
  if (!hasZstd) {
    console.log('  (skip zstd: 当前 Node 运行时不支持，需 Node 22.15+/24+)');
    return;
  }
  const c = zstdCompressSync!(JSON_BUF);
  assert.ok(bufferOf(decompressBuffer(c, 'zstd')).equals(JSON_BUF));
  assert.deepEqual(decodeRequestBody(c, 'zstd').parsed, PARSED);
}

function testCorruptedNotThrow(): void {
  const garbage = Buffer.from('这不是合法压缩数据', 'utf-8');
  // 损坏 gzip：返回 error，不抛
  const rg = decompressBuffer(garbage, 'gzip');
  assert.equal(rg.ok, false);
  if (!rg.ok) assert.match(rg.error, /解压失败/);

  // 损坏 zstd（若运行时支持）
  if (hasZstd) {
    const rz = decompressBuffer(garbage, 'zstd');
    assert.equal(rz.ok, false);
  }

  // decodeRequestBody 对损坏数据：parsed undefined，error 存在，不抛
  const dr = decodeRequestBody(garbage, 'gzip');
  assert.equal(dr.parsed, undefined);
  assert.ok(dr.error);
}

function testValidCompressionButNonJson(): void {
  const c = zlib.gzipSync(Buffer.from('plain text not json', 'utf-8'));
  const r = decodeRequestBody(c, 'gzip');
  assert.equal(r.parsed, undefined);
  assert.match(r.error ?? '', /JSON/);
}

function testUnknownEncoding(): void {
  const r = decompressBuffer(JSON_BUF, 'braille');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /未知/);
}

function testMultiValueEncodingDegrades(): void {
  // 多值 content-encoding 不逐层解，降级
  const r = decompressBuffer(JSON_BUF, 'gzip, zstd');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /多值/);
}

function testCaseAndWhitespace(): void {
  const gz = zlib.gzipSync(JSON_BUF);
  // 大写
  assert.ok(bufferOf(decompressBuffer(gz, 'GZIP')).equals(JSON_BUF));
  // 前后空格
  assert.ok(bufferOf(decompressBuffer(gz, ' gzip ')).equals(JSON_BUF));
  if (hasZstd) {
    const z = zstdCompressSync!(JSON_BUF);
    assert.ok(bufferOf(decompressBuffer(z, ' ZSTD ')).equals(JSON_BUF));
  }
}

function testEmptyBuffer(): void {
  // 空 body：无 parsed 无 error，不抛
  const r = decodeRequestBody(Buffer.alloc(0), undefined);
  assert.equal(r.parsed, undefined);
  assert.equal(r.error, undefined);
  // 空 body 带编码也不抛（length===0 早返回）
  const r2 = decodeRequestBody(Buffer.alloc(0), 'gzip');
  assert.equal(r2.parsed, undefined);
  assert.equal(r2.error, undefined);
}

testIdentity();
testGzip();
testDeflate();
testBrotli();
testZstd();
testCorruptedNotThrow();
testValidCompressionButNonJson();
testUnknownEncoding();
testMultiValueEncodingDegrades();
testCaseAndWhitespace();
testEmptyBuffer();

console.log('body-decode tests passed');
