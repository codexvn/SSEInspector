/**
 * ws-proxy 升级桥接集成测试。
 *
 * 骨架复用 proxy-data-plane.test.ts：require.cache 注入 recorder mock、
 * 真实 httpxy 数据面。mock 上游为裸 http.Server 的 'upgrade' 处理器
 * （手写 101 回写 + 帧解析器读客户端帧 + 按脚本写未掩码信封帧）；
 * 客户端用 http.request 的 upgrade 事件手工对话（帧构造见 ws-helpers），
 * 以便精确携带 sec-websocket-extensions 头验证剥离行为。
 *
 * 场景顺序说明：轻场景（开发模式让位、生产模式销毁、h2c 拒绝桥接）放在
 * 进程状态干净的最前面执行；完整桥接场景放在最后，收尾立即清理并显式退出——
 * Node 24 / Windows 上 socket 拆除后的空闲窗口存在偶发的进程级竞态，
 * 避免「重拆除残留 + 长空闲」的组合可以稳定测试。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import type { CaptureMetadata } from '../src/recorder/protocol';
import { createWebSocketFrameParser, WS_OPCODE_TEXT } from '../src/recorder/ws-frames';
import { buildFrame, clientJsonFrame, serverJsonFrame, OP_TEXT } from './ws-helpers';

interface WsObservation {
  opens: CaptureMetadata[];
  chunks: Array<{ id: string; dir: 'request' | 'response'; chunk: Buffer }>;
  closes: Array<{ id: string; reason: string; error?: string }>;
}

const require = createRequire(__filename);
const clientPath = require.resolve('../src/recorder/client');

const observation: WsObservation = { opens: [], chunks: [], closes: [] };

/** 场景 E：h2c 拒绝桥接后经普通 request 管线收到的请求 */
const httpEvents: Array<{ method?: string; url?: string; upgradeHeader?: string; body: string }> = [];

const recorderMock = {
  beginWsCapture: (metadata: CaptureMetadata) => observation.opens.push(metadata),
  wsCaptureChunk: (id: string, dir: 'request' | 'response', chunk: Uint8Array) =>
    observation.chunks.push({ id, dir, chunk: Buffer.from(chunk) }),
  endWsCapture: (id: string, reason: string, error?: string) => observation.closes.push({ id, reason, error }),
  beginCapture: () => {},
  captureRequestChunk: () => {},
  endCaptureRequest: () => {},
  beginCaptureResponse: () => {},
  captureResponseChunk: () => {},
  completeCapture: () => {},
  closeCapture: () => {},
  failCapture: () => {},
  startRecorder: async () => {},
  stopRecorder: async () => {},
  recorderAvailable: () => true,
  onRecorderUiEvent: () => () => {},
  recorderRpc: async () => {},
};

// tsx 导出 getter 只读，必须在加载 ws-proxy / proxy 前注入 mock 模块
for (const key of Object.keys(require.cache)) {
  if (key.includes(`${path.sep}recorder${path.sep}client`) || /[\\/]proxy\.(ts|js)$/.test(key) || /[\\/]ws-proxy\.(ts|js)$/.test(key)) {
    delete require.cache[key];
  }
}
require.cache[clientPath] = {
  id: clientPath,
  filename: clientPath,
  loaded: true,
  exports: recorderMock,
} as NodeModule;

const { setConfig } = require('../src/config') as typeof import('../src/config');
const { createUpgradeHandler } = require('../src/ws-proxy') as typeof import('../src/ws-proxy');

interface ClientConnection {
  socket: import('node:net').Socket;
  messages: unknown[];
  send(payload: Buffer): void;
}

/** 手工 WebSocket 客户端：http.request 发起升级，升级成功后可收发原始帧 */
function dial(port: number, requestPath: string, extraHeaders: Record<string, string> = {}): Promise<ClientConnection> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'),
        'sec-websocket-version': '13',
        authorization: 'Bearer test-token',
        ...extraHeaders,
      },
    });
    req.on('upgrade', (_res, socket) => {
      const connection: ClientConnection = {
        socket,
        messages: [],
        send: payload => socket.write(payload),
      };
      const parser = createWebSocketFrameParser();
      socket.on('data', chunk => {
        for (const frame of parser.push(chunk)) {
          if (frame.opcode === WS_OPCODE_TEXT) {
            connection.messages.push(JSON.parse(frame.payload.toString('utf8')));
          }
        }
      });
      resolve(connection);
    });
    req.on('response', res => reject(new Error(`意外收到普通响应: ${res.statusCode}`)));
    req.on('error', reject);
    req.end();
  });
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function listen(server: http.Server): Promise<number> {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
}

function concatDir(dir: 'request' | 'response'): Buffer {
  return Buffer.concat(observation.chunks.filter(c => c.dir === dir).map(c => c.chunk));
}

/** 把一个方向的 tee 字节解析回文本帧 JSON（验证录制的是完整可解析的原始字节流） */
function parseTextEvents(bytes: Buffer): unknown[] {
  const parser = createWebSocketFrameParser();
  return parser
    .push(bytes)
    .filter(frame => frame.opcode === WS_OPCODE_TEXT)
    .map(frame => JSON.parse(frame.payload.toString('utf8')));
}

async function main(): Promise<void> {
  // ---- mock 上游：升级握手 + 收到 response.create 后回放两帧信封 ----
  let upstreamHeaders: IncomingHttpHeaders | null = null;
  let upstreamUrlSeen = '';
  const upstreamSockets: import('node:net').Socket[] = [];
  const upstream = http.createServer();
  upstream.on('upgrade', (req, socket) => {
    upstreamHeaders = req.headers;
    upstreamUrlSeen = req.url ?? '';
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${String(req.headers['sec-websocket-key'] ?? '')}\r\n\r\n`,
    );
    const parser = createWebSocketFrameParser();
    socket.on('data', chunk => {
      for (const frame of parser.push(chunk)) {
        if (frame.opcode !== WS_OPCODE_TEXT) continue;
        const event = JSON.parse(frame.payload.toString('utf8')) as { type: string; stream_id?: string };
        if (event.type === 'response.create') {
          socket.write(serverJsonFrame({
            type: 'message',
            stream_id: event.stream_id,
            message: { type: 'response.created', response: { id: 'resp_ws_1' } },
          }));
          socket.write(serverJsonFrame({
            type: 'message',
            stream_id: event.stream_id,
            message: { type: 'response.completed', response: { id: 'resp_ws_1', usage: { total_tokens: 3 } } },
          }));
        }
      }
    });
    upstreamSockets.push(socket);
  });
  const upstreamPort = await listen(upstream);
  setConfig({ upstreamUrl: `http://127.0.0.1:${upstreamPort}` });

  const proxyServer = http.createServer((req, res) => {
    // 场景 E：非 WebSocket 升级被拒绝后经 'connection' 重放进普通请求管线
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      httpEvents.push({
        method: req.method,
        url: req.url,
        upgradeHeader: req.headers.upgrade,
        body: Buffer.concat(chunks).toString(),
      });
      const payload = req.url === '/v1/models' ? 'second-ok' : 'first-ok';
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
    });
  });
  proxyServer.on('upgrade', createUpgradeHandler({ isDev: false, server: proxyServer }));
  const proxyPort = await listen(proxyServer);

  // ---- 场景 A：开发模式未注册路径让位（不销毁、不响应、不录制） ----
  const devServer = http.createServer();
  devServer.on('upgrade', createUpgradeHandler({ isDev: true, server: devServer }));
  const devPort = await listen(devServer);
  let devOutcome: 'handled' | 'silent' = 'silent';
  const devReq = http.request({
    host: '127.0.0.1',
    port: devPort,
    path: '/v1/other',
    headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==', 'sec-websocket-version': '13' },
  });
  // 让位的语义是「什么都不发生」：静默期满 300ms 即通过；被销毁/被响应都算失败
  devReq.on('upgrade', () => { devOutcome = 'handled'; });
  devReq.on('response', () => { devOutcome = 'handled'; });
  devReq.on('error', () => { devOutcome = 'handled'; });
  devReq.end();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(devOutcome, 'silent', '开发模式未注册路径不应被销毁或响应');
  devReq.destroy();

  // ---- 场景 B：生产模式未注册路径被销毁 ----
  const unregistered = await new Promise<boolean>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/other',
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==', 'sec-websocket-version': '13' },
    });
    req.on('upgrade', () => resolve(false));
    req.on('response', () => resolve(false));
    req.on('error', () => resolve(true));
    req.end();
    setTimeout(() => reject(new Error('未注册路径既未销毁也未响应')), 4000);
  });
  assert.ok(unregistered, '生产模式未注册升级路径应被销毁');

  // ---- 场景 E：非 WebSocket 升级（h2c）被优雅拒绝并桥接回普通请求管线 ----
  // JDK HttpClient（默认 HTTP/2）对明文 http:// 的每个新连接先发 h2c 升级尝试；
  // 拒绝后请求应作为普通 HTTP/1.1 处理（收到正常响应与请求体），且同一连接
  // 可继续复用（第二个纯 1.1 请求直接成功）
  const h2cFlow = await new Promise<string>((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => {
      s.write(
        'POST /v1/chat/completions HTTP/1.1\r\n'
        + 'Connection: Upgrade, HTTP2-Settings\r\n'
        + 'Content-Length: 5\r\n'
        + 'Host: x\r\n'
        + 'HTTP2-Settings: AAEAAEAAAAIAAAAAAAMAAAAAAAQBAAAAAAUAAEAAAAYABgAA\r\n'
        + 'Upgrade: h2c\r\n'
        + 'User-Agent: Java-http-client/21.0.7\r\n'
        + '\r\nhello',
      );
    });
    let raw = '';
    let secondSent = false;
    s.on('data', chunk => {
      raw += chunk.toString();
      if (!secondSent && raw.includes('first-ok')) {
        secondSent = true;
        s.write('GET /v1/models HTTP/1.1\r\nHost: x\r\n\r\n');
      }
      if (raw.includes('second-ok')) {
        s.end();
        resolve(raw);
      }
    });
    s.on('error', reject);
    setTimeout(() => reject(new Error(`h2c bridge timeout, raw=${raw.slice(0, 120)}`)), 4000);
  });
  // 第一个响应是正常 HTTP/1.1 应答（非 101、非重置）
  assert.ok(h2cFlow.startsWith('HTTP/1.1 200'), 'h2c 请求应收到普通 200 响应');
  // 桥接后的请求：升级头已被剥离、请求体完整送达
  assert.equal(httpEvents.length, 2);
  assert.deepEqual(
    { ...httpEvents[0], upgradeHeader: httpEvents[0].upgradeHeader ?? 'stripped' },
    { method: 'POST', url: '/v1/chat/completions', upgradeHeader: 'stripped', body: 'hello' },
  );
  assert.equal(httpEvents[1].url, '/v1/models');
  // h2c 桥接不产生任何 WS 录制
  assert.equal(observation.opens.length, 0);

  // ---- 场景 C：完整桥接与录制 ----
  const client = await dial(proxyPort, '/v1/responses?x=1', {
    'sec-websocket-extensions': 'permessage-deflate; client_max_window_bits',
  });
  client.send(clientJsonFrame({ type: 'response.create', stream_id: 't1', model: 'gpt-test' }));

  const messages = await waitFor(() => (client.messages.length >= 2 ? client.messages : undefined));
  assert.deepEqual(messages, [
    { type: 'message', stream_id: 't1', message: { type: 'response.created', response: { id: 'resp_ws_1' } } },
    { type: 'message', stream_id: 't1', message: { type: 'response.completed', response: { id: 'resp_ws_1', usage: { total_tokens: 3 } } } },
  ]);

  // 上游看到的请求：路径含查询串、鉴权头透传、压缩扩展已被剥离
  assert.ok(upstreamHeaders);
  assert.equal(upstreamUrlSeen, '/v1/responses?x=1');
  assert.equal(upstreamHeaders.authorization, 'Bearer test-token');
  assert.ok(!('sec-websocket-extensions' in upstreamHeaders));

  // 录制：连接级 ws_open 元数据正确
  assert.equal(observation.opens.length, 1);
  const open = observation.opens[0];
  assert.equal(open.method, 'WS');
  assert.equal(open.path, '/v1/responses');
  assert.equal(open.apiType, 'openai');
  assert.equal(open.apiEndpoint, 'openai-responses');
  assert.equal(open.requestHeaders.authorization, 'Bearer test-token');

  // 录制：两个方向的 tee 字节都能完整解析回帧
  await waitFor(() => (parseTextEvents(concatDir('response')).length >= 2 ? true : undefined));
  const requestEvents = parseTextEvents(concatDir('request')).filter(e => (e as { type: string }).type === 'response.create');
  assert.equal(requestEvents.length, 1);
  assert.deepEqual(requestEvents[0], { type: 'response.create', stream_id: 't1', model: 'gpt-test' });
  const responseEvents = parseTextEvents(concatDir('response'));
  assert.equal(responseEvents.length, 2);

  // ---- 场景 D：下游断开 → downstream_closed（destroy 模拟客户端突然断开；
  //      TCP 半关闭 end() 只结束可读侧，mock 上游不回关会让双方半开悬挂） ----
  client.socket.destroy();
  const close = await waitFor(() => observation.closes[0]);
  assert.equal(close.reason, 'downstream_closed');

  // 让位与销毁场景都不产生录制
  assert.equal(observation.opens.length, 1);
  assert.equal(observation.closes.length, 1);

  // ---- 清理：升级连接可能半关闭导致 server.close() 永久等待，强制断开全部连接 ----
  client.socket.destroy();
  for (const socket of upstreamSockets) socket.destroy();
  proxyServer.close();
  proxyServer.closeAllConnections();
  devServer.close();
  devServer.closeAllConnections();
  upstream.close();
  upstream.closeAllConnections();
  console.log('ws-proxy tests passed');
  // Node 24 / Windows 在 socket 拆除后的空闲窗口存在偶发进程竞态，测试完成后立即退出
  process.exit(0);
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
