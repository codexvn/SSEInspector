/**
 * format-timing 纯函数测试：耗时分解列的单行文本与悬停完整分解。
 *
 * 覆盖：四种状态的紧凑文本形态（pending 显示发送、streaming 显示首字进行中、
 * done 显示首字+流、缺数据回退 —）；时长格式三档（ms / 秒 / 分秒）；
 * 悬停分解含网络字节与吞吐的组合与缺失字段的降级。
 */
import assert from 'node:assert/strict'
import { formatDuration, timingText, timingTitle } from '../src/format-timing'

// ---- formatDuration：三档格式 ----
assert.equal(formatDuration(0), '0ms')
assert.equal(formatDuration(823), '823ms')
assert.equal(formatDuration(999), '999ms')
assert.equal(formatDuration(1200), '1.20s')
assert.equal(formatDuration(59_400), '59.40s')
assert.equal(formatDuration(63_400), '1m03s')
assert.equal(formatDuration(123_456), '2m03s')

// ---- timingText：状态形态 ----
// pending：已发送完成时显示发送耗时，否则占位
assert.equal(timingText({ state: 'pending', requestSentMs: 830 }), '发送830ms')
assert.equal(timingText({ state: 'pending' }), '—')
// streaming：首字已到显示首字+流进行中，未到显示等待首字
assert.equal(timingText({ state: 'streaming', firstChunkMs: 1200 }), '首字1.20s·流…')
assert.equal(timingText({ state: 'streaming' }), '首字…')
// done：首字 + 流（总耗时 - 首字）；旧记录无打点时回退占位
assert.equal(timingText({ state: 'done', firstChunkMs: 1000, durationMs: 5000 }), '首字1.00s·流4.00s')
assert.equal(timingText({ state: 'done', firstChunkMs: 900, durationMs: 1000 }), '首字900ms·流100ms')
assert.equal(timingText({ state: 'done', durationMs: 5000 }), '—')
// error 状态与 done 同形态（有打点就显示）
assert.equal(timingText({ state: 'error', firstChunkMs: 1000, durationMs: 3000 }), '首字1.00s·流2.00s')
// 流时长不会为负（duration 早于首字的异常数据被钳制）
assert.equal(timingText({ state: 'done', firstChunkMs: 2000, durationMs: 1500 }), '首字2.00s·流0ms')

// ---- timingTitle：完整分解（含网络层字节与吞吐） ----
const full = timingTitle({
  state: 'done',
  requestSentMs: 800,
  firstChunkMs: 1200,
  durationMs: 5300,
  requestBytes: 1_700_000,
  responseBytes: 240_000,
})
assert.ok(full.includes('发送 800ms（1.6 MiB）'), `发送段含字节: ${full}`)
assert.ok(full.includes('首字 1.20s'), `首字段: ${full}`)
assert.ok(full.includes('接收 4.10s（234.4 KiB，57.2 KiB/s）'), `接收段含吞吐: ${full}`)
assert.ok(full.includes('总计 5.30s'), `总计段: ${full}`)

// 仅有耗时时无字节段，不出现 NaN 吞吐
const minimal = timingTitle({ state: 'done', firstChunkMs: 100, durationMs: 400 })
assert.equal(minimal, '首字 100ms · 总计 400ms')

// 完全无数据时给明确占位说明
assert.equal(timingTitle({ state: 'done', durationMs: 1000 }), '总计 1.00s')
assert.equal(timingTitle({ state: 'pending' }), '暂无分段耗时数据')

console.log('format timing tests passed')
