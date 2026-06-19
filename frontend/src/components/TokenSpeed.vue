<script lang="ts">
/** 模块级单例缓存：纯文本 → token 数，跨所有 TokenSpeed 实例共享，避免列表多行重复请求后端 */
const tokenCountCache = new Map<string, number>()
</script>

<script setup lang="ts">
import { ref, watch, onUnmounted, computed } from 'vue'
import type { ApiEndpoint } from '../types'
import { fetchTokenize } from '../api'

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
let tokenizeTimer: ReturnType<typeof setTimeout> | null = null

/** 当前已取得的 token 数（流式实时更新） */
let currentTokens = 0

/** 解析单个 SSE data 行为对象，失败返回 null */
function parseDataLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const data = trimmed.slice(5).trim()
  if (data === '[DONE]') return null
  try { return JSON.parse(data) as Record<string, unknown> } catch { return null }
}

/** OpenAI Chat：拼接 choices[].delta.content */
function extractOpenAIChat(raw: string): string {
  let out = ''
  for (const line of raw.split(/\r?\n/)) {
    const obj = parseDataLine(line)
    if (!obj) continue
    const choices = obj.choices as { delta?: { content?: string } }[] | undefined
    if (Array.isArray(choices)) {
      for (const c of choices) {
        if (typeof c?.delta?.content === 'string') out += c.delta.content
      }
    }
  }
  return out
}

/** OpenAI Responses：拼接 response.output_text.delta 的 delta 字符串 */
function extractOpenAIResponses(raw: string): string {
  let out = ''
  for (const line of raw.split(/\r?\n/)) {
    const obj = parseDataLine(line)
    if (!obj) continue
    if (typeof obj.type === 'string' && obj.type.endsWith('output_text.delta') && typeof obj.delta === 'string') {
      out += obj.delta
    }
  }
  return out
}

/** Anthropic：拼接 content_block_delta 的 delta.text / delta.thinking */
function extractAnthropic(raw: string): string {
  let out = ''
  for (const line of raw.split(/\r?\n/)) {
    const obj = parseDataLine(line)
    if (!obj) continue
    if (obj.type === 'content_block_delta') {
      const delta = obj.delta as { text?: string; thinking?: string } | undefined
      if (delta) {
        if (typeof delta.text === 'string') out += delta.text
        if (typeof delta.thinking === 'string') out += delta.thinking
      }
    }
  }
  return out
}

/** 按响应格式从 SSE 原始文本中提取纯输出文本 */
function extractOutputText(raw: string): string {
  switch (props.endpoint) {
    case 'openai-chat': return extractOpenAIChat(raw)
    case 'openai-responses': return extractOpenAIResponses(raw)
    case 'anthropic-messages': return extractAnthropic(raw)
    default: return extractOpenAIChat(raw) + extractOpenAIResponses(raw) + extractAnthropic(raw)
  }
}

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
  const cached = tokenCountCache.get(text)
  if (cached !== undefined) { currentTokens = cached; return }
  try {
    const result = await fetchTokenize(text, props.model)
    tokenCountCache.set(text, result.count)
    currentTokens = result.count
  } catch {
    // 接口失败时回退到字符估算（约 4 字符/token）
    currentTokens = Math.ceil(text.length / 4)
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
  // 流式中：提取纯文本，防抖调 tokenize 接口，定时刷新显示
  if (!props.text) { speedText.value = '…'; return }
  const text = extractOutputText(props.text)
  if (tokenizeTimer) clearTimeout(tokenizeTimer)
  tokenizeTimer = setTimeout(() => { refreshTokenCount(text) }, 300)
  renderLiveSpeed()
}

// 流式中文本变化即时刷新
watch(() => props.text, updateSpeed)
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
  if (tokenizeTimer) clearTimeout(tokenizeTimer)
})
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
