import { ApiEndpoint } from './types';

export interface ApiUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
}

export function serializeApiUsage(response: unknown): string | undefined {
  if (!isRecord(response) || !isRecord(response.usage)) return undefined;
  return JSON.stringify(response.usage);
}

export function parseOutputTokens(apiUsage: string): number | undefined {
  const usage = parseUsageObject(apiUsage);
  if (!usage) return undefined;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens;
  return typeof outputTokens === 'number' ? outputTokens : undefined;
}

export function parseUsageSummary(apiUsage: string | null | undefined, endpoint: ApiEndpoint): ApiUsageSummary {
  if (!apiUsage) return {};
  const usage = parseUsageObject(apiUsage);
  if (!usage) return {};

  switch (endpoint) {
    case 'openai-chat':
      return compactSummary(
        numberValue(usage.prompt_tokens) ?? numberValue(usage.input_tokens),
        numberValue(usage.completion_tokens) ?? numberValue(usage.output_tokens),
        cachedTokens(usage.prompt_tokens_details) ?? cachedTokens(usage.input_tokens_details),
      );
    case 'openai-responses':
      return compactSummary(
        numberValue(usage.input_tokens),
        numberValue(usage.output_tokens),
        cachedTokens(usage.input_tokens_details) ?? numberValue(usage.cache_read_input_tokens),
      );
    case 'anthropic-messages': {
      const input = sumDefined(
        numberValue(usage.input_tokens),
        numberValue(usage.cache_creation_input_tokens),
        numberValue(usage.cache_read_input_tokens),
      );
      return compactSummary(
        input,
        numberValue(usage.output_tokens),
        numberValue(usage.cache_read_input_tokens),
      );
    }
  }
  return assertNever(endpoint);
}

function parseUsageObject(apiUsage: string): Record<string, unknown> | undefined {
  const value = JSON.parse(apiUsage) as unknown;
  return isRecord(value) ? value : undefined;
}

function compactSummary(inputTokens?: number, outputTokens?: number, cacheRead?: number): ApiUsageSummary {
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function cachedTokens(value: unknown): number | undefined {
  return isRecord(value) ? numberValue(value.cached_tokens) : undefined;
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? present.reduce((total, value) => total + value, 0) : undefined;
}

function assertNever(value: never): never {
  throw new Error(`未实现的 endpoint usage: ${String(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
