export function formatTokenSpeed(
  state: 'streaming' | 'done' | 'error',
  outputTokens?: number,
  durationMs?: number,
): string {
  if (state === 'streaming') return '接收中'
  if (!outputTokens || !durationMs || durationMs <= 0) return '-'
  return `${(outputTokens / (durationMs / 1000)).toFixed(1)} tok/s`
}
