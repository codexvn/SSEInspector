import { ApiType, TokenBreakdown, OpenAIResponsesUsage, MergedContent } from './types';
import { resolveTokenizer, ResolvedTokenizer } from './token-registry';

function sourceLabel(t: ResolvedTokenizer | null): string | undefined {
  return t?.source;
}

// ---- 公共 helper ----

function extractTools(body: Record<string, unknown>): unknown[] {
  const tools = body.tools;
  if (Array.isArray(tools)) return tools;
  return [];
}

let gptFallback: ((text: string) => number) | null = null;
function getGptFallback(): (text: string) => number {
  if (!gptFallback) {
    const { encode } = require('gpt-tokenizer');
    gptFallback = (text: string) => encode(text).length;
  }
  return gptFallback;
}

// ---- 提取模型名 ----

function extractModel(responseContent: MergedContent | null, body: Record<string, unknown>): string {
  if (responseContent && typeof responseContent === 'object' && 'model' in responseContent) {
    const m = (responseContent as unknown as Record<string, unknown>).model;
    if (typeof m === 'string' && m) return m;
  }
  const bm = body.model;
  if (typeof bm === 'string' && bm) return bm;
  return 'unknown';
}

// ---- OpenAI Chat ----

function isOpenAIChatBody(body: Record<string, unknown>): boolean {
  return Array.isArray(body.messages);
}

async function breakDownOpenAIChat(
  body: Record<string, unknown>,
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_miss_tokens?: number };
  } | null,
  tokenizer: ResolvedTokenizer | null,
): Promise<TokenBreakdown | null> {
  const encode = tokenizer?.encoder ?? getGptFallback();
  const allMessages = body.messages as { role: string; content: string }[];

  // 剥离 system 消息
  const systemMessages = allMessages.filter(m => m.role === 'system');
  const chatMessages = allMessages.filter(m => m.role === 'user' || m.role === 'assistant');
  const toolMessages = allMessages.filter(m => m.role === 'tool');

  // systemPrompt
  let systemPrompt = 0;
  for (const msg of systemMessages) {
    systemPrompt += encode(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
  }

  // messages（使用 encodeChat 含 role 开销，只处理 user/assistant）
  let messages = 0;
  if (chatMessages.length > 0) {
    try {
      const { encodeChat } = require('gpt-tokenizer');
      messages = encodeChat(
        chatMessages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
        'gpt-4',
      ).length;
    } catch {
      for (const msg of chatMessages) {
        messages += encode(JSON.stringify(msg));
      }
    }
  }

  // tool 消息
  for (const msg of toolMessages) {
    messages += encode(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
  }

  // tools
  const tools = encode(JSON.stringify(extractTools(body)));

  const cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const totalInput = messages + tools + systemPrompt;
  // OpenAI Chat 的 prompt_tokens 已包含缓存的 token，无需额外加上
  const apiReportedInput = usage?.prompt_tokens ?? 0;

  return { messages, tools, systemPrompt, cacheRead, totalInput, apiReportedInput, tokenizerSource: sourceLabel(tokenizer) };
}

// ---- OpenAI Responses ----

function isOpenAIResponsesBody(body: Record<string, unknown>): boolean {
  return body.input !== undefined;
}

async function breakDownOpenAIResponses(
  body: Record<string, unknown>,
  usage: OpenAIResponsesUsage | null,
  tokenizer: ResolvedTokenizer | null,
): Promise<TokenBreakdown | null> {
  const encode = tokenizer?.encoder ?? getGptFallback();
  let messages = 0;

  const input = body.input;
  if (typeof input === 'string') {
    messages = encode(input);
  } else if (typeof input === 'object' && input !== null) {
    messages = encode(JSON.stringify(input));
  }

  let systemPrompt = 0;
  const instructions = body.instructions;
  if (typeof instructions === 'string') {
    systemPrompt = encode(instructions);
  } else if (typeof instructions === 'object' && instructions !== null) {
    systemPrompt = encode(JSON.stringify(instructions));
  }

  let textFormatTokens = 0;
  const textConfig = body.text as Record<string, unknown> | undefined;
  if (textConfig && typeof textConfig === 'object') {
    textFormatTokens = encode(JSON.stringify(textConfig));
  }

  const tools = encode(JSON.stringify(extractTools(body)));
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const totalInput = messages + tools + systemPrompt + textFormatTokens;
  const apiReportedInput = (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);

  return {
    messages, tools,
    systemPrompt: systemPrompt + textFormatTokens,
    cacheRead, totalInput, apiReportedInput,
    tokenizerSource: sourceLabel(tokenizer),
  };
}

// ---- Anthropic ----

function isAnthropicBody(body: Record<string, unknown>): boolean {
  return Array.isArray(body.messages) && (body.system !== undefined || body.tools !== undefined || body.model !== undefined);
}

function stringifyAnthropicContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(block => {
      if (typeof block === 'string') return block;
      if (typeof block === 'object' && block !== null) {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        if (b.type === 'tool_result' || b.type === 'tool_use') return JSON.stringify(b);
        if (b.type === 'image') return '[image]';
        if (b.type === 'thinking' && typeof b.thinking === 'string') return b.thinking;
      }
      return JSON.stringify(block);
    }).join('\n');
  }
  return JSON.stringify(content);
}

async function breakDownAnthropic(
  body: Record<string, unknown>,
  usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | null,
  tokenizer: ResolvedTokenizer | null,
): Promise<TokenBreakdown | null> {
  const encode = tokenizer?.encoder ?? getGptFallback();
  let messages = 0;

  const rawMessages = body.messages as { role: string; content: unknown }[] | undefined;
  if (rawMessages) {
    for (const msg of rawMessages) {
      const text = stringifyAnthropicContent(msg.content);
      messages += encode(text);
    }
  }

  let systemPrompt = 0;
  const system = body.system;
  if (typeof system === 'string') {
    systemPrompt = encode(system);
  } else if (Array.isArray(system)) {
    systemPrompt = encode(JSON.stringify(system));
  } else if (typeof system === 'object' && system !== null) {
    systemPrompt = encode(JSON.stringify(system));
  }

  const tools = encode(JSON.stringify(extractTools(body)));

  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const totalInput = messages + tools + systemPrompt;
  const apiReportedInput = (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);

  return { messages, tools, systemPrompt, cacheRead, totalInput, apiReportedInput, tokenizerSource: sourceLabel(tokenizer) };
}

// ---- 统一入口 ----

export async function computeTokenBreakdown(
  body: unknown,
  responseContent: MergedContent | null,
  apiType: ApiType,
): Promise<TokenBreakdown | null> {
  if (!body || typeof body !== 'object') return null;

  const bodyObj = body as Record<string, unknown>;
  const model = extractModel(responseContent, bodyObj);
  const tokenizer = await resolveTokenizer(model);

  try {
    if (apiType === 'openai') {
      if (isOpenAIResponsesBody(bodyObj)) {
        const usage = responseContent && 'usage' in responseContent
          ? (responseContent as { usage?: OpenAIResponsesUsage }).usage ?? null
          : null;
        return await breakDownOpenAIResponses(bodyObj, usage, tokenizer);
      }
      if (isOpenAIChatBody(bodyObj)) {
        const usage = responseContent && 'usage' in responseContent
          ? (responseContent as {
            usage?: {
              prompt_tokens: number;
              completion_tokens: number;
              total_tokens: number;
              prompt_tokens_details?: { cached_tokens?: number; cache_miss_tokens?: number };
            }
          }).usage ?? null
          : null;
        return await breakDownOpenAIChat(bodyObj, usage, tokenizer);
      }
      return null;
    }

    if (apiType === 'anthropic') {
      const usage = responseContent && 'usage' in responseContent
        ? (responseContent as { usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } }).usage ?? null
        : null;
      return await breakDownAnthropic(bodyObj, usage, tokenizer);
    }

    return null;
  } catch (err) {
    console.error(`[token-counter] 计算失败: ${(err as Error).message}`);
    return null;
  }
}
