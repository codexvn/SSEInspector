import { ApiEndpoint, ApiType, RequestListFilter } from '../types';

export interface CaptureMetadata {
  id: string;
  startedAt: number;
  timestamp: string;
  method: string;
  path: string;
  upstreamUrl: string;
  requestHeaders: Record<string, string>;
  contentEncoding?: string;
  apiType: ApiType;
  apiEndpoint: ApiEndpoint;
  sessionId?: string;
  sessionIdKey?: string;
}

export type RecorderRpcMethod =
  | 'requests.list'
  | 'requests.detail'
  | 'requests.prev'
  | 'requests.next'
  | 'requests.stats'
  | 'requests.neighbors'
  | 'tools.list'
  | 'tools.pair';

export interface RecorderRpcArgs {
  'requests.list': [number | undefined, number | undefined, RequestListFilter, string | undefined];
  'requests.detail': [string];
  'requests.prev': [string];
  'requests.next': [string];
  'requests.stats': [];
  'requests.neighbors': [string];
  'tools.list': [string];
  'tools.pair': [string, string];
}

export interface RecorderUiEvent {
  payload: string;
  recordId: string;
  structural: boolean;
}

export type CaptureCloseReason = 'downstream_closed' | 'request_aborted';

export type MainToRecorderMessage =
  | { type: 'capture.start'; metadata: CaptureMetadata }
  | { type: 'capture.request_chunk'; id: string; chunk: Uint8Array }
  | { type: 'capture.request_end'; id: string }
  | { type: 'capture.response_start'; id: string; status: number; headers: Record<string, string>; streaming: boolean }
  | { type: 'capture.response_chunk'; id: string; chunk: Uint8Array }
  | { type: 'capture.complete'; id: string }
  | { type: 'capture.closed'; id: string; status: number; reason: CaptureCloseReason }
  | { type: 'capture.failed'; id: string; status: number; error: string }
  | { type: 'rpc'; correlationId: number; method: RecorderRpcMethod; args: unknown[] }
  | { type: 'shutdown' };

export type RecorderToMainMessage =
  | { type: 'ready' }
  | { type: 'ack'; id: string; bytes: number }
  | { type: 'ui.event'; event: RecorderUiEvent }
  | { type: 'rpc.result'; correlationId: number; ok: true; value: unknown }
  | { type: 'rpc.result'; correlationId: number; ok: false; error: string }
  | { type: 'fatal'; error: string };
