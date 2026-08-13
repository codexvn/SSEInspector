import { AnthropicAccumulator } from './stream-accumulators/anthropic';
import { OpenAIChatAccumulator } from './stream-accumulators/openai-chat';
import { OpenAIResponsesAccumulator } from './stream-accumulators/openai-responses';
import { StreamAccumulator } from './stream-accumulators/types';
import { ApiEndpoint, ApiType, MergedContent } from './types';

export interface EndpointDefinition {
  endpoint: ApiEndpoint;
  provider: ApiType;
  routePattern: RegExp;
  createAccumulator(): StreamAccumulator<MergedContent>;
}

/** AI 端点键（不含 passthrough，passthrough 无 accumulator 或路由模式）。 */
type EndpointKey = Exclude<ApiEndpoint, typeof ApiEndpoint.Passthrough>;

const ENDPOINT_REGISTRY: Readonly<Record<EndpointKey, EndpointDefinition>> = Object.freeze({
  'openai-chat': {
    endpoint: 'openai-chat',
    provider: 'openai',
    routePattern: /\/chat\/completions$/,
    createAccumulator: () => new OpenAIChatAccumulator(),
  },
  'openai-responses': {
    endpoint: 'openai-responses',
    provider: 'openai',
    routePattern: /\/responses$/,
    createAccumulator: () => new OpenAIResponsesAccumulator(),
  },
  'anthropic-messages': {
    endpoint: 'anthropic-messages',
    provider: 'anthropic',
    routePattern: /\/messages$/,
    createAccumulator: () => new AnthropicAccumulator(),
  },
});

export const ENDPOINT_DEFINITIONS: readonly EndpointDefinition[] = Object.freeze(
  Object.values(ENDPOINT_REGISTRY),
);

export function getEndpointDefinition(endpoint: ApiEndpoint): EndpointDefinition {
  const def = ENDPOINT_REGISTRY[endpoint as EndpointKey];
  if (!def) throw new Error(`passthrough endpoint 无定义: ${endpoint}`);
  return def;
}

export function resolveEndpoint(path: string): EndpointDefinition {
  const matches = ENDPOINT_DEFINITIONS.filter(definition => definition.routePattern.test(path));
  if (matches.length !== 1) {
    throw new Error(`请求路径必须且只能匹配一个已注册 AI endpoint: path=${path}, matches=${matches.length}`);
  }
  return matches[0];
}

export function assertEndpointProvider(path: string, actualProvider: string): EndpointDefinition {
  const definition = resolveEndpoint(path);
  if (definition.provider !== actualProvider) {
    throw new Error(
      `请求 endpoint/provider 不一致: path=${path}, actual=${actualProvider}, expected=${definition.provider}`,
    );
  }
  return definition;
}
