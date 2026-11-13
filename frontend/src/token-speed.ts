/**
 * 速度展示：进行中只显示状态文案（不实时估算）；终态以 usage 返回的输出
 * token 为主，缺失时以响应字符数兜底（单位区分，不做 token 数的换算猜测）。
 */
export function formatTokenSpeed(
  state: 'pending' | 'streaming' | 'done' | 'error',
  outputTokens?: number,
  durationMs?: number,
  responseChars?: number,
): string {
  if (state === 'pending') return '等待响应'
  if (state === 'streaming') return '接收中'
  if (!durationMs || durationMs <= 0) return '-'
  if (outputTokens) return `${(outputTokens / (durationMs / 1000)).toFixed(1)} tok/s`
  if (responseChars) return `${Math.round(responseChars / (durationMs / 1000))} 字/s`
  return '-'
}
