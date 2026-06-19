import type { ApiEndpoint, ApiProvider } from '../types'

/** 按 path + apiType 判定 API 响应格式。
 *  优先用 path 正则精确匹配，apiType 作为兜底（与 MessageFlow.detectFormat 的 path 分支一致）。 */
export function detectApiEndpoint(path: string | undefined, apiType: ApiProvider): ApiEndpoint {
  if (path && /\/chat\/completions(?:\?|$)/.test(path)) return 'openai-chat'
  if (path && /\/responses(?:\?|$)/.test(path)) return 'openai-responses'
  if (path && /\/messages(?:\?|$)/.test(path)) return 'anthropic-messages'
  return apiType === 'anthropic' ? 'anthropic-messages' : 'openai-chat'
}
