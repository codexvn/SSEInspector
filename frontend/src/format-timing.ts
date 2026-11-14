/**
 * 列表「耗时分解」列的格式化纯函数。
 *
 * 指标口径（与后端 CaptureState 打点一致，参考 CLIProxyAPI 的 Latency/TTFT 模型）：
 * - 发送 requestSentMs：客户端请求体发送完成（客户端→代理收完）；
 * - 首字 firstChunkMs：首个响应 chunk 到达（TTFT 近似，无 chunk 时退回响应头到达）；
 * - 接收（流）= durationMs - firstChunkMs；网络吞吐 = responseBytes / 接收耗时。
 * 单行文本保持紧凑（列表行高不变），完整分解放 title 悬停提示。
 */
import { formatBytes } from './format'

export interface TimingInput {
  state: 'pending' | 'streaming' | 'done' | 'error'
  requestSentMs?: number
  firstChunkMs?: number
  durationMs?: number
  requestBytes?: number
  responseBytes?: number
}

/** 毫秒 → 紧凑可读时长：<1s 用 ms，≥1s 保留两位小数，≥60s 用 m:ss */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  const totalSec = Math.floor(ms / 1000)
  return `${Math.floor(totalSec / 60)}m${String(totalSec % 60).padStart(2, '0')}s`
}

function receiveMs(t: TimingInput): number | undefined {
  if (t.firstChunkMs == null || t.durationMs == null) return undefined
  return Math.max(0, t.durationMs - t.firstChunkMs)
}

/** 单行紧凑文本：done/error 显示「首字+流」，streaming 显示进行中形态 */
export function timingText(t: TimingInput): string {
  const receive = receiveMs(t)
  if (t.state === 'pending') {
    return t.requestSentMs != null ? `发送${formatDuration(t.requestSentMs)}` : '—'
  }
  if (t.state === 'streaming') {
    return t.firstChunkMs != null ? `首字${formatDuration(t.firstChunkMs)}·流…` : '首字…'
  }
  if (t.firstChunkMs == null) return '—'
  return receive == null
    ? `首字${formatDuration(t.firstChunkMs)}`
    : `首字${formatDuration(t.firstChunkMs)}·流${formatDuration(receive)}`
}

/** 悬停完整分解：发送（字节）/ 首字 / 接收（字节与吞吐）/ 总耗时 */
export function timingTitle(t: TimingInput): string {
  const parts: string[] = []
  if (t.requestSentMs != null) {
    parts.push(`发送 ${formatDuration(t.requestSentMs)}${t.requestBytes != null ? `（${formatBytes(t.requestBytes)}）` : ''}`)
  }
  if (t.firstChunkMs != null) parts.push(`首字 ${formatDuration(t.firstChunkMs)}`)
  const receive = receiveMs(t)
  if (receive != null && t.responseBytes != null) {
    const throughput = receive > 0 ? `，${formatBytes(Math.round((t.responseBytes / receive) * 1000))}/s` : ''
    parts.push(`接收 ${formatDuration(receive)}（${formatBytes(t.responseBytes)}${throughput}）`)
  }
  if (t.durationMs != null) parts.push(`总计 ${formatDuration(t.durationMs)}`)
  return parts.length > 0 ? parts.join(' · ') : '暂无分段耗时数据'
}
