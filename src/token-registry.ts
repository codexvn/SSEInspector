import { TokenizerLoader } from '@lenml/tokenizers';
import { countTokens as anthropicCountTokens } from '@anthropic-ai/tokenizer';
import https from 'https';
import http from 'http';

// ---- 类型 ----

type Encoder = (text: string) => number;

// ---- 镜像 ----

const HF_MIRRORS = [
  process.env.HF_MIRROR,
  'https://huggingface.co/',
].filter(Boolean) as string[];

// ---- 模型名→HuggingFace repo ----
//
// 从 @lenml/tokenizers 源码 scripts/dl_hf_models.mjs 提取。
// GPT 系列由 gpt-tokenizer 处理，Claude 由 @anthropic-ai/tokenizer 处理，
// 此处只映射 HF 上有独立 tokenizer 的模型。
// 很多 repo 使用 Xenova（transformers.js 作者）的 tokenizer 镜像。

const MODEL_REPOS: Record<string, string> = {
  // ── DeepSeek ──
  'deepseek_v4':     'deepseek-ai/DeepSeek-V4-Flash',
  'deepseek-v4':     'deepseek-ai/DeepSeek-V4-Flash',
  'deepseek_v3':     'deepseek-ai/DeepSeek-V3',
  'deepseek-v3':     'deepseek-ai/DeepSeek-V3',
  'deepseek-r1':     'deepseek-ai/DeepSeek-V3',
  'deepseek-v2':     'deepseek-ai/DeepSeek-V2',
  'deepseek':        'deepseek-ai/DeepSeek-V3',

  // ── Qwen ──
  'qwen3':           'Qwen/Qwen3-4B',
  'qwen2_5':         'Qwen/Qwen2.5-1.5B-Instruct',
  'qwen2.5':         'Qwen/Qwen2.5-1.5B-Instruct',
  'qwen2':           'Qwen/Qwen2.5-1.5B-Instruct',
  'qwen1_5':         'Qwen/Qwen1.5-72B-Chat',
  'qwen':            'Qwen/Qwen2.5-1.5B-Instruct',

  // ── Llama ──
  'llama3_2':        'Xenova/Llama-3.2-Tokenizer',
  'llama-3.2':       'Xenova/Llama-3.2-Tokenizer',
  'llama3_1':        'Xenova/llama3-tokenizer-new',
  'llama-3.1':       'Xenova/llama3-tokenizer-new',
  'llama3':          'NousResearch/Meta-Llama-3-8B',
  'llama-3':         'NousResearch/Meta-Llama-3-8B',
  'llama2':          'mistral-community/Mixtral-8x22B-v0.1',
  'llama':           'Xenova/Llama-3.2-Tokenizer',

  // ── Mistral ──
  'mistral_nemo':    'nbeerbower/mistral-nemo-wissenschaft-12B',
  'mistral-nemo':    'nbeerbower/mistral-nemo-wissenschaft-12B',

  // ── Gemma / Gemini ──
  'gemma3':          'unsloth/gemma-3-1b-it',
  'gemma-3':         'unsloth/gemma-3-1b-it',
  'gemma2':          'Xenova/gemma2-tokenizer',
  'gemma-2':         'Xenova/gemma2-tokenizer',
  'gemma':           'beomi/gemma-mling-7b',
  'gemini':          'Xenova/gemini-nano',

  // ── GPT-OSS ──
  'gptoss':          'openai/gpt-oss-20b',
  'gpt-oss':         'openai/gpt-oss-20b',

  // ── 国产模型 ──
  'baichuan2':       'baichuan-inc/Baichuan2-7B-Chat',
  'chatglm3':        'THUDM/chatglm3-6b',
  'internlm2':       'internlm/internlm2-1_8b',
  'yi':              '01-ai/YI-34B',
  'kimi_k2':         'moonshotai/Kimi-K2-Instruct-0905',
  'kimi-k2':         'moonshotai/Kimi-K2-Instruct-0905',
  'minicpm':         'openbmb/MiniCPM-V-4_5',

  // ── Cohere ──
  'command_r_plus':  'CohereForAI/c4ai-command-r-plus',
  'command-r-plus':  'CohereForAI/c4ai-command-r-plus',

  // ── Aya ──
  'aya':             'adamo1139/aya-expanse-8b-ungated',
};

// ---- 缓存 ----

const hfTokenizers = new Map<string, { encode: (text: string) => number[] }>();
const hfLoading = new Map<string, Promise<{ encode: (text: string) => number[] } | null>>();

// ---- https 下载 ----

function downloadJSON(url: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      // 处理重定向
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirect = new URL(res.headers.location, url).href;
        resolve(downloadJSON(redirect, timeoutMs));
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function loadFromHF(repo: string): Promise<{ encode: (text: string) => number[] } | null> {
  let lastErr: Error | null = null;

  for (const mirror of HF_MIRRORS) {
    const base = `${mirror.replace(/\/$/, '')}/${repo}/resolve/main/`;
    try {
      const [json, config] = await Promise.all([
        downloadJSON(base + 'tokenizer.json'),
        downloadJSON(base + 'tokenizer_config.json'),
      ]);
      const tokenizer = TokenizerLoader.fromPreTrained({
        tokenizerJSON: JSON.parse(json),
        tokenizerConfig: JSON.parse(config),
      });
      console.error(`[token-registry] 已加载 tokenizer: ${repo} (via ${mirror})`);
      return { encode: (text: string) => tokenizer.encode(text) };
    } catch (err) {
      lastErr = err as Error;
    }
  }
  console.error(`[token-registry] 加载 tokenizer 失败: ${repo} — ${lastErr?.message}`);
  return null;
}

async function getHFTokenizer(modelLower: string): Promise<Encoder | null> {
  for (const [key, repo] of Object.entries(MODEL_REPOS)) {
    if (!modelLower.includes(key)) continue;

    if (hfTokenizers.has(repo)) {
      const t = hfTokenizers.get(repo)!;
      return (text: string) => t.encode(text).length;
    }

    if (!hfLoading.has(repo)) {
      hfLoading.set(repo, loadFromHF(repo).then(t => {
        if (t) hfTokenizers.set(repo, t);
        hfLoading.delete(repo);
        return t;
      }));
    }
    const t = await hfLoading.get(repo)!;
    if (t) return (text: string) => t.encode(text).length;
    return null;
  }
  return null;
}

// ---- OpenAI / Anthropic ----

function gptEncoder(): Encoder {
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
  if (/gpt|o1|o3|o4|openai|cl100k|o200k/.test(modelLower)) return 'openai';
  if (/claude|anthropic/.test(modelLower)) return 'anthropic';
  for (const key of Object.keys(MODEL_REPOS)) {
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
