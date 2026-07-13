<script lang="ts">
/** 模块级单例缓存：模型 + 纯文本 → token 数，跨实例共享。 */
const tokenCountCache = new Map<string, number>()
const pendingTokenCounts = new Map<string, Promise<number>>()
const MAX_TOKEN_CACHE_ENTRIES = 256
</script>

<script setup lang="ts">
import { ref, watch, onUnmounted, computed } from 'vue'
import type { ApiEndpoint } from '../types'
import { fetchTokenize } from '../api'
import { formatErrorChain } from '../error'
import { IncrementalSseTextExtractor } from '../stream-text'

const props = defineProps<{
  /** 流式原始文本（实时估算用，流式中由 SSE 推送更新） */
  text?: string
  /** 请求开始时间戳，实时估算的分母 */
  startTime?: number
  /** 响应格式，决定如何从 SSE 文本提取输出文本 */
  endpoint: ApiEndpoint
  /** 记录状态：streaming 时实时估算，其余用完成值 */
  state: 'streaming' | 'done' | 'error'
  /** 完成后 API 报告的输出 token 数 */
  outputTokens?: number
  /** 完成后总耗时毫秒 */
  durationMs?: number
  /** 模型名，供后端 tokenizer 路由 */
  model?: string
}>()

const speedText = ref('')
let speedTimer: ReturnType<typeof setInterval> | null = null

/** 流式实时速度刷新间隔（节流）：与 speedTimer 每秒刷显示的节奏对齐，避免每次 SSE 推送都调后端 */
const TOKENIZE_INTERVAL = 1000

/** 当前已取得的 token 数（流式实时更新） */
let currentTokens = 0
/** 上次调用后端 tokenize 的时间戳，用于流式节流（防抖在持续流式下永不触发） */
let lastTokenizeAt = 0
let textExtractor = new IncrementalSseTextExtractor(props.endpoint)
let extractedText = ''
let lastRequestedText = ''

/** 完成态精确速度：output_tokens ÷ 耗时秒 */
const finalSpeed = computed<string>(() => {
  if (!props.outputTokens || !props.durationMs) return '-'
  const seconds = props.durationMs / 1000
  if (seconds <= 0) return '-'
  return (props.outputTokens / seconds).toFixed(1) + ' tok/s'
})

/** 调后端 tokenizer 计算纯文本 token 数（带缓存） */
async function refreshTokenCount(text: string) {
  if (!text || !props.model) { currentTokens = 0; return }
  lastRequestedText = text
  const key = `${props.model}\u0000${text}`
  const cached = tokenCountCache.get(key)
  if (cached !== undefined) { currentTokens = cached; return }
  try {
    let pending = pendingTokenCounts.get(key)
    if (!pending) {
      pending = fetchTokenize(text, props.model).then(result => result.count)
      pendingTokenCounts.set(key, pending)
    }
    const count = await pending
    cacheTokenCount(key, count)
    if (lastRequestedText === text) currentTokens = count
  } catch (error) {
    console.warn(`[TokenSpeed] token 计算失败，使用字符估算: ${formatErrorChain(error)}`)
    if (lastRequestedText === text) currentTokens = Math.ceil(text.length / 4)
  } finally {
    pendingTokenCounts.delete(key)
  }
}

/** 流式实时速度显示（用当前 token 数 ÷ 已耗时） */
function renderLiveSpeed() {
  if (!props.startTime) { speedText.value = '…'; return }
  const elapsed = (Date.now() - props.startTime) / 1000
  if (elapsed <= 0) { speedText.value = '…'; return }
  speedText.value = `≈ ${(currentTokens / elapsed).toFixed(1)} tok/s`
}

function updateSpeed() {
  // 非流式：显示完成值
  if (props.state !== 'streaming') {
    speedText.value = finalSpeed.value
    return
  }
  // 流式中：提取纯文本，节流调 tokenize 接口（用最新文本），定时刷新显示
  if (!props.text) { speedText.value = '…'; return }
  const text = extractedText
  // 节流：距上次刷新超过间隔才真正调后端，否则用已有 currentTokens 渲染。
  // 注意：流式 props.text 每 ~200ms 变化一次，用 debounce(停止才触发) 会导致后端调用永不触发、速度恒为 0。
  if (Date.now() - lastTokenizeAt >= TOKENIZE_INTERVAL) {
    lastTokenizeAt = Date.now()
    void refreshTokenCount(text)
  }
  renderLiveSpeed()
}

// 流式中文本变化即时刷新
watch([() => props.text, () => props.endpoint], ([raw, endpoint], previous) => {
  if (!previous || endpoint !== previous[1]) {
    textExtractor = new IncrementalSseTextExtractor(endpoint)
    extractedText = ''
  }
  extractedText = textExtractor.accept(raw ?? '')
  updateSpeed()
}, { immediate: true })
// 状态变化（streaming→done）切换到完成值
watch(() => props.state, () => {
  if (speedTimer) { clearInterval(speedTimer); speedTimer = null }
  updateSpeed()
  if (props.state === 'streaming' && props.startTime) {
    speedTimer = setInterval(renderLiveSpeed, 1000)
  }
}, { immediate: true })

onUnmounted(() => {
  if (speedTimer) clearInterval(speedTimer)
})

function cacheTokenCount(key: string, count: number) {
  tokenCountCache.set(key, count)
  if (tokenCountCache.size <= MAX_TOKEN_CACHE_ENTRIES) return
  const oldest = tokenCountCache.keys().next().value
  if (oldest !== undefined) tokenCountCache.delete(oldest)
}
</script>

<template>
  <span class="token-speed">{{ speedText }}</span>
</template>

<style scoped>
.token-speed {
  font-family: var(--font-mono); font-size: 0.78rem; color: var(--accent);
  white-space: nowrap;
}
</style>
