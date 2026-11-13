/**
 * 展示层共享纯函数：传输形态标签与字节数格式化。
 * transportTag 依赖后端契约——WebSocket 连接以 method='WS' 记录
 * （ws-proxy 的 beginWsCapture），HTTP 按是否 SSE 响应区分。
 */

/** 传输形态小标签：WS 升级 / SSE 流式 / JSON 非流式 */
export function transportTag(record: { method: string; streaming: boolean }): string {
  if (record.method === 'WS') return 'WS'
  return record.streaming ? 'SSE' : 'JSON'
}

/** 1024 进制字节数格式化（B / KiB / MiB） */
export function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MiB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KiB`
  return `${size} B`
}
