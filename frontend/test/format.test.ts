import assert from 'node:assert/strict'
import { formatBytes, transportTag } from '../src/format'

// 传输形态标签：WS 升级按 method 判定，HTTP 按 SSE 响应区分
assert.equal(transportTag({ method: 'WS', streaming: true }), 'WS')
assert.equal(transportTag({ method: 'POST', streaming: true }), 'SSE')
assert.equal(transportTag({ method: 'POST', streaming: false }), 'JSON')
assert.equal(transportTag({ method: 'GET', streaming: false }), 'JSON')

// 字节数格式化：1024 进制三档
assert.equal(formatBytes(0), '0 B')
assert.equal(formatBytes(512), '512 B')
assert.equal(formatBytes(2048), '2.0 KiB')
assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MiB')

console.log('format tests passed')
