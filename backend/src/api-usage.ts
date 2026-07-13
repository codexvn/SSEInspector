export function serializeApiUsage(response: unknown): string | undefined {
  if (!isRecord(response) || !isRecord(response.usage)) return undefined;
  return JSON.stringify(response.usage);
}

export function parseOutputTokens(apiUsage: string): number | undefined {
  const usage = JSON.parse(apiUsage) as {
    completion_tokens?: unknown;
    output_tokens?: unknown;
  };
  const outputTokens = usage.completion_tokens ?? usage.output_tokens;
  return typeof outputTokens === 'number' ? outputTokens : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
