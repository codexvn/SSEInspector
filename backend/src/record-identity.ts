import { assertEndpointProvider } from './endpoints';
import { ApiEndpoint, ApiType } from './types';

export interface RecordIdentity {
  kind: 'ai' | 'passthrough';
  provider: ApiType;
  endpoint: ApiEndpoint;
}

export function resolveRecordIdentity(input: {
  path: string;
  apiType: ApiType;
  apiEndpoint: ApiEndpoint;
}): RecordIdentity {
  const isPassthroughType = input.apiType === ApiType.Passthrough;
  const isPassthroughEndpoint = input.apiEndpoint === ApiEndpoint.Passthrough;
  if (isPassthroughType || isPassthroughEndpoint) {
    if (!isPassthroughType || !isPassthroughEndpoint) {
      throw new Error(
        `passthrough 记录的 apiType/apiEndpoint 必须同时为 passthrough: path=${input.path}, apiType=${input.apiType}, apiEndpoint=${input.apiEndpoint}`,
      );
    }
    return {
      kind: 'passthrough',
      provider: ApiType.Passthrough,
      endpoint: ApiEndpoint.Passthrough,
    };
  }

  const definition = assertEndpointProvider(input.path, input.apiType);
  if (definition.endpoint !== input.apiEndpoint) {
    throw new Error(
      `写入记录的 apiEndpoint 与 path 不一致: path=${input.path}, actual=${input.apiEndpoint}, expected=${definition.endpoint}`,
    );
  }
  return {
    kind: 'ai',
    provider: definition.provider,
    endpoint: definition.endpoint,
  };
}

export function isPassthroughEndpoint(endpoint: ApiEndpoint): boolean {
  return endpoint === ApiEndpoint.Passthrough;
}
