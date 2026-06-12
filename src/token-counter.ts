import { encodeChat, encode } from 'gpt-tokenizer';
import { ApiType, TokenBreakdown, OpenAIResponsesUsage, MergedContent } from './types';

const DEFAULT_MODEL = 'gpt-4';

// ---- 公共 helper ----

function extractTools(body: Record<string, unknown>): unknown[] {
  const tools = body.tools;
  if (Array.isArray(tools)) return tools;
  return [];
}

function countTokens(text: string): number {
  try {
    return encode(text).length;
  } catch {
    // 极端情况：文本无法编码时回退到字符估算
    return Math.ceil(text.length / 3.5);
  }
}

// ---- OpenAI Chat ----

function isOpenAIChatBody(body: Record<string, unknown>): boolean {
  return Array.isArray(body.messages);
}

function breakDownOpenAIChat(
  body: Record<string, unknown>,
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null,
): TokenBreakdown | null {
  const allMessages = body.messages as { role: string; content: string }[];

  // 剥离 system 消息
  const systemMessages = allMessages.filter(m => m.role === 'system');
  const chatMessages = allMessages.filter(m => m.role === 'user' || m.role === 'assistant');
  const toolMessages = allMessages.filter(m => m.role === 'tool');

  // systemPrompt token
  let systemPrompt = 0;
  if (systemMessages.length > 0) {
    for (const msg of systemMessages) {
      systemPrompt += countTokens(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
    }
  }

  // messages token（使用 encodeChat 含 role 开销，只处理 user/assistant）
  let messages = 0;
  if (chatMessages.length > 0) {
    try {
      messages = encodeChat(
        chatMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
        DEFAULT_MODEL,
      ).length;
    } catch {
      for (const msg of chatMessages) {
        messages += countTokens(JSON.stringify(msg));
      }
    }
  }

  // tool 消息（工具调用结果）单独计算
  for (const msg of toolMessages) {
    messages += countTokens(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
  }

  // tools token
  const tools = countTokens(JSON.stringify(extractTools(body)));

  const cacheRead = 0;
  const totalInput = messages + tools + systemPrompt;
  const apiReportedInput = usage?.prompt_tokens ?? 0;

  return { messages, tools, systemPrompt, cacheRead, totalInput, apiReportedInput };
}

// ---- OpenAI Responses API ----

function isOpenAIResponsesBody(body: Record<string, unknown>): boolean {
  return body.input !== undefined;
}

function breakDownOpenAIResponses(
  body: Record<string, unknown>,
  usage: OpenAIResponsesUsage | null,
): TokenBreakdown | null {
  let messages = 0;

  // body.input 是用户输入文本
  const input = body.input;
  if (typeof input === 'string') {
    messages = encode(input).length;
  } else if (typeof input === 'object' && input !== null) {
    messages = encode(JSON.stringify(input)).length;
  }

  // body.instructions 是系统指令
  let systemPrompt = 0;
  const instructions = body.instructions;
  if (typeof instructions === 'string') {
    systemPrompt = encode(instructions).length;
  } else if (typeof instructions === 'object' && instructions !== null) {
    systemPrompt = encode(JSON.stringify(instructions)).length;
  }

  // body.text 包含文本格式配置（如 text.format）
  let textFormatTokens = 0;
  const textConfig = body.text as Record<string, unknown> | undefined;
  if (textConfig && typeof textConfig === 'object') {
    textFormatTokens = encode(JSON.stringify(textConfig)).length;
  }

  const tools = countTokens(JSON.stringify(extractTools(body)));
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const totalInput = messages + tools + systemPrompt + textFormatTokens;
  const apiReportedInput = (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);

  return {
    messages,
    tools,
    systemPrompt: systemPrompt + textFormatTokens,
    cacheRead,
    totalInput,
    apiReportedInput,
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
      }
      return JSON.stringify(block);
    }).join('\n');
  }
  return JSON.stringify(content);
}

function breakDownAnthropic(
  body: Record<string, unknown>,
  usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | null,
): TokenBreakdown | null {
  let messages = 0;

  const rawMessages = body.messages as { role: string; content: unknown }[] | undefined;
  if (rawMessages) {
    for (const msg of rawMessages) {
      const text = stringifyAnthropicContent(msg.content);
      messages += countTokens(text);
    }
  }

  // system prompt
  let systemPrompt = 0;
  const system = body.system;
  if (typeof system === 'string') {
    systemPrompt = encode(system).length;
  } else if (Array.isArray(system)) {
    systemPrompt = encode(JSON.stringify(system)).length;
  } else if (typeof system === 'object' && system !== null) {
    systemPrompt = encode(JSON.stringify(system)).length;
  }

  // tools
  const tools = countTokens(JSON.stringify(extractTools(body)));

  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const totalInput = messages + tools + systemPrompt;
  const apiReportedInput = (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);

  return { messages, tools, systemPrompt, cacheRead, totalInput, apiReportedInput };
}

// ---- 统一入口 ----

export function computeTokenBreakdown(
  body: unknown,
  responseContent: MergedContent | null,
  apiType: ApiType,
): TokenBreakdown | null {
  if (!body || typeof body !== 'object') return null;

  const bodyObj = body as Record<string, unknown>;

  try {
    if (apiType === 'openai') {
      // 区分 Chat Completions 和 Responses API
      if (isOpenAIResponsesBody(bodyObj)) {
        const usage = responseContent && 'usage' in responseContent
          ? (responseContent as { usage?: OpenAIResponsesUsage }).usage ?? null
          : null;
        return breakDownOpenAIResponses(bodyObj, usage);
      }
      if (isOpenAIChatBody(bodyObj)) {
        const usage = responseContent && 'usage' in responseContent
          ? (responseContent as { usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }).usage ?? null
          : null;
        return breakDownOpenAIChat(bodyObj, usage);
      }
      return null;
    }

    if (apiType === 'anthropic') {
      const usage = responseContent && 'usage' in responseContent
        ? (responseContent as { usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } }).usage ?? null
        : null;
      return breakDownAnthropic(bodyObj, usage);
    }

    return null;
  } catch (err) {
    console.error(`[token-counter] 计算失败: ${(err as Error).message}`);
    return null;
  }
}
