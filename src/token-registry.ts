import { TokenizerLoader } from '@lenml/tokenizers';
import { countTokens as anthropicCountTokens } from '@anthropic-ai/tokenizer';

// ---- 类型 ----

type Encoder = (text: string) => number;

interface TokenizerSource {
  type: 'gpt';                         // gpt-tokenizer（本地精确）
  getEncoder: () => Encoder;
}

// ---- HuggingFace 模型→repo 映射 ----

const HF_REPOS: Record<string, string> = {
  // DeepSeek
  'deepseek-v4': 'https://huggingface.co/deepseek-ai/DeepSeek-V3/resolve/main/',
  'deepseek-v3': 'https://huggingface.co/deepseek-ai/DeepSeek-V3/resolve/main/',
  'deepseek-r1': 'https://huggingface.co/deepseek-ai/DeepSeek-R1/resolve/main/',
  'deepseek-v2': 'https://huggingface.co/deepseek-ai/DeepSeek-V2/resolve/main/',
  'deepseek':    'https://huggingface.co/deepseek-ai/DeepSeek-V3/resolve/main/',

  // Qwen
  'qwen3':  'https://huggingface.co/Qwen/Qwen3-235B-A22B/resolve/main/',
  'qwen2.5': 'https://huggingface.co/Qwen/Qwen2.5-72B-Instruct/resolve/main/',
  'qwen2':  'https://huggingface.co/Qwen/Qwen2-72B-Instruct/resolve/main/',
  'qwen':   'https://huggingface.co/Qwen/Qwen2.5-72B-Instruct/resolve/main/',

  // Llama
  'llama-4': 'https://huggingface.co/meta-llama/Llama-4-Scout-17B-16E-Instruct/resolve/main/',
  'llama-3.2': 'https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct/resolve/main/',
  'llama-3.1': 'https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct/resolve/main/',
  'llama-3': 'https://huggingface.co/meta-llama/Meta-Llama-3-8B-Instruct/resolve/main/',
  'llama':   'https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct/resolve/main/',

  // Mistral
  'mistral-large': 'https://huggingface.co/mistralai/Mistral-Large-Instruct-2411/resolve/main/',
  'mistral-small': 'https://huggingface.co/mistralai/Mistral-Small-24B-Instruct-2501/resolve/main/',
  'mistral-nemo':  'https://huggingface.co/mistralai/Mistral-Nemo-Instruct-2407/resolve/main/',
  'mistral':       'https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.3/resolve/main/',

  // Gemma
  'gemma-3': 'https://huggingface.co/google/gemma-3-27b-it/resolve/main/',
  'gemma-2': 'https://huggingface.co/google/gemma-2-9b-it/resolve/main/',
  'gemma':   'https://huggingface.co/google/gemma-2-9b-it/resolve/main/',
};

const hfTokenizers = new Map<string, { encode: (text: string) => number[] }>();
const hfLoading = new Map<string, Promise<{ encode: (text: string) => number[] } | null>>();

async function loadFromHF(repoUrl: string): Promise<{ encode: (text: string) => number[] } | null> {
  try {
    const tokenizer = await TokenizerLoader.fromPreTrainedUrls({
      tokenizerJSON: repoUrl + 'tokenizer.json',
      tokenizerConfig: repoUrl + 'tokenizer_config.json',
    });
    return {
      encode: (text: string) => tokenizer.encode(text),
    };
  } catch (err) {
    console.error(`[token-registry] 下载 tokenizer 失败: ${repoUrl} — ${(err as Error).message}`);
    return null;
  }
}

async function getHFTokenizer(modelLower: string): Promise<Encoder | null> {
  // 匹配已知 HF repo
  for (const [key, url] of Object.entries(HF_REPOS)) {
    if (modelLower.includes(key)) {
      if (hfTokenizers.has(url)) {
        const t = hfTokenizers.get(url)!;
        return (text: string) => t.encode(text).length;
      }

      // 避免并发重复下载
      if (!hfLoading.has(url)) {
        hfLoading.set(url, loadFromHF(url).then(t => {
          if (t) hfTokenizers.set(url, t);
          hfLoading.delete(url);
          return t;
        }));
      }

      const t = await hfLoading.get(url)!;
      if (t) {
        return (text: string) => t.encode(text).length;
      }
      return null;
    }
  }
  return null;
}

// ---- OpenAI / Anthropic ----

function gptEncoder(): Encoder {
  // 延迟 require，避免循环依赖
  const { encode } = require('gpt-tokenizer');
  return (text: string) => encode(text).length;
}

function anthropicEncoder(): Encoder {
  return (text: string) => anthropicCountTokens(text);
}

// ---- 路由 ----

export interface ResolvedTokenizer {
  encoder: Encoder;
  source: 'gpt-tokenizer' | '@anthropic-ai/tokenizer' | 'hf-download';
  modelLabel: string;
}

const resolvedCache = new Map<string, ResolvedTokenizer | null>();

function matchSource(modelLower: string): 'openai' | 'anthropic' | 'hf' | null {
  // OpenAI
  if (/gpt|o1|o3|o4|openai|cl100k|o200k/.test(modelLower)) return 'openai';
  // Anthropic
  if (/claude|anthropic/.test(modelLower)) return 'anthropic';
  // HF 映射中有匹配
  for (const key of Object.keys(HF_REPOS)) {
    if (modelLower.includes(key)) return 'hf';
  }
  return null;
}

export async function resolveTokenizer(model: string): Promise<ResolvedTokenizer | null> {
  const modelLower = model.toLowerCase();
  const cached = resolvedCache.get(modelLower);
  if (cached !== undefined) return cached;

  const source = matchSource(modelLower);

  let result: ResolvedTokenizer | null = null;

  switch (source) {
    case 'openai':
      result = { encoder: gptEncoder(), source: 'gpt-tokenizer', modelLabel: model };
      break;
    case 'anthropic':
      result = { encoder: anthropicEncoder(), source: '@anthropic-ai/tokenizer', modelLabel: model };
      break;
    case 'hf': {
      const enc = await getHFTokenizer(modelLower);
      if (enc) {
        result = { encoder: enc, source: 'hf-download', modelLabel: model };
      }
      break;
    }
  }

  // 无精确匹配，回退 gpt-tokenizer（标注为 fallback）
  if (!result) {
    result = { encoder: gptEncoder(), source: 'gpt-tokenizer', modelLabel: model };
  }

  resolvedCache.set(modelLower, result);
  return result;
}

/** 重置缓存（用于测试或手动刷新 tokenizer） */
export function clearTokenizerCache(): void {
  resolvedCache.clear();
  hfTokenizers.clear();
  hfLoading.clear();
}
