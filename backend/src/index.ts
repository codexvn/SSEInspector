import 'reflect-metadata';
import express from 'express';
import compression from 'compression';
import path from 'path';
import type { Server } from 'http';
import { handleProxy, handlePassthrough, initializeProxy } from './proxy';
import { config } from './config';
import { RequestListFilter } from './types';
import { ENDPOINT_DEFINITIONS } from './endpoints';
import {
  onRecorderUiEvent,
  recorderAvailable,
  recorderRpc,
  startRecorder,
  stopRecorder,
} from './recorder/client';
import { RecorderUiEventBuffer } from './recorder/ui-event-buffer';
import { RecorderUiEvent } from './recorder/protocol';
import { getLogger, serializeError } from './logger';

const serverLogger = getLogger('server');
const apiLogger = getLogger('api');
const passthroughLogger = getLogger('passthrough');
const shutdownLogger = getLogger('shutdown');

/**
 * 运行模式判定。
 * - 生产模式（NODE_ENV=production，经 bin/sse-inspector.js 启动）：用原生 express.static 服务前端构建产物。
 * - 开发模式（tsx 直跑 index.ts）：用 vite-express 提供 HMR。
 */
const isDev = process.env.NODE_ENV !== 'production';

/** 端口：由 CLI 入口 setConfig 填充（bin/sse-inspector.js --port） */
const PORT = config.port;
/** 上游 URL：由 CLI 入口 setConfig 填充（bin/sse-inspector.js --upstream） */
const UPSTREAM_URL = config.upstreamUrl;
const SHUTDOWN_TIMEOUT_MS = 5000;
let server: Server | null = null;
let shutdownStarted = false;

if (!UPSTREAM_URL) {
  serverLogger.error({ argument: '--upstream' }, 'upstream URL is not configured');
  process.exit(1);
}

/** 包装 async handler：任意 reject 自动 → 500 + 打印日志 */
function route(fn: (req: express.Request, res: express.Response) => Promise<void>) {
  return (req: express.Request, res: express.Response) => {
    fn(req, res).catch((err) => {
      apiLogger.error({ method: req.method, path: req.path, err: serializeError(err) }, 'API request failed');
      if (!res.headersSent) {
        const unavailable = !recorderAvailable();
        res.status(unavailable ? 503 : 500).json({
          error: unavailable ? '检查器暂不可用' : '服务器内部错误',
        });
      }
    });
  };
}

function parseRequestListFilter(value: unknown): RequestListFilter {
  const allowedFilters: RequestListFilter[] = ['all', 'openai', 'anthropic', 'streaming', 'error'];
  return allowedFilters.includes(value as RequestListFilter) ? value as RequestListFilter : 'all';
}

async function start() {
  await initializeProxy();
  await startRecorder();
  const app = express();

  app.use('/api', compression({
    // SSE 响应不压缩：压缩流会缓冲小块数据，导致 /api/events 推送不及时
    filter: (req, res) => {
      const type = res.getHeader('Content-Type');
      if (typeof type === 'string' && type.includes('text/event-stream')) return false;
      return compression.filter(req, res);
    },
  }));

  // 仅 /api 路由需要解析 JSON body。
  // 代理路由（/chat/completions、/responses、/messages）与 catch-all 透传必须保持原始请求体，
  // 不得经过任何 body 消费型中间件——否则压缩请求体（gzip/deflate/br/zstd）会被消费破坏透明性，
  // body-parser 也会对不支持的编码（如 zstd）抛 UnsupportedMediaTypeError；代理请求流由 proxy.ts 直接转发。
  app.use('/api', express.json({ limit: '10mb' }));

  // ---- API 路由 ----

  app.get('/api/requests', route(async (req, res) => {
    const page = parseInt(req.query.page as string) || undefined;
    const pageSize = parseInt(req.query.pageSize as string) || undefined;
    const filter = parseRequestListFilter(req.query.filter);
    // 可选会话维度过滤，与类别 filter 正交组合
    const sessionIdRaw = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : '';
    const sessionId = sessionIdRaw || undefined;
    res.json(await recorderRpc('requests.list', page, pageSize, filter, sessionId));
  }));

  app.get('/api/requests/:id', route(async (req, res) => {
    const record = await recorderRpc('requests.detail', req.params.id);
    if (!record) {
      apiLogger.warn({ requestId: req.params.id }, 'request record not found');
      res.status(404).json({ error: 'Request not found' });
      return;
    }
    res.json(record);
  }));

  // 同一会话中指定请求的上一条 / 下一条
  app.get('/api/requests/:id/prev', route(async (req, res) => {
    res.json(await recorderRpc('requests.prev', req.params.id));
  }));

  app.get('/api/requests/:id/next', route(async (req, res) => {
    res.json(await recorderRpc('requests.next', req.params.id));
  }));

  app.get('/api/stats', route(async (_req, res) => {
    res.json(await recorderRpc('requests.stats'));
  }));

  app.get('/api/requests/:id/neighbors', route(async (req, res) => {
    res.json(await recorderRpc('requests.neighbors', req.params.id));
  }));

  // SSE events stream
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let blocked = false;
    const pendingEvents = new RecorderUiEventBuffer();
    const writeEvent = (event: RecorderUiEvent) => {
      if (blocked) {
        pendingEvents.push(event);
        return;
      }
      blocked = !res.write(event.payload);
    };
    const onDrain = () => {
      blocked = false;
      let event = pendingEvents.shift();
      while (event && !blocked) {
        writeEvent(event);
        event = blocked ? undefined : pendingEvents.shift();
      }
    };
    res.on('drain', onDrain);

    const removeUpdate = onRecorderUiEvent(writeEvent);

    const heartbeat = setInterval(() => {
      if (!blocked && pendingEvents.empty) res.write(': heartbeat\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      removeUpdate();
      res.off('drain', onDrain);
    });
  });

  app.get('/api/tool-calls', route(async (req, res) => {
    const requestId = req.query.requestId as string;
    const toolName = req.query.toolName as string;
    const toolCallId = req.query.toolCallId as string;
    if (toolName && toolCallId) {
      res.json(await recorderRpc('tools.pair', toolName, toolCallId));
    } else if (requestId) {
      res.json(await recorderRpc('tools.list', requestId));
    } else {
      res.status(400).json({ error: 'Need requestId or toolName+toolCallId' });
    }
  }));

  // ---- Proxy 路由 ----

  for (const definition of ENDPOINT_DEFINITIONS) {
    app.post(definition.routePattern, route((req, res) => handleProxy(req, res, definition)));
  }

  // ---- 前端静态资源 ----

  if (isDev) {
    // 开发模式：vite-express 直接从 frontend/ 源码目录起 Vite dev server（HMR）
    // vite-express 是 CJS 包，直接导出 config/listen/static；
    // ESM 上下文（tsx 直跑 index.ts）下经 cjs 互操作会包成 .default，CJS 上下文（bin --dev 经 tsx/cjs/api）则无 .default，故兼容两者。
    const ve = require('vite-express');
    const ViteExpress = ve.default ?? ve;
    const frontRoot = path.resolve(__dirname, '..', '..', 'frontend');
    ViteExpress.config({ inlineViteConfig: { root: frontRoot } });
    app.use(ViteExpress.static());
  } else {
    // 生产模式：直接服务 frontend/dist 静态产物（前端用 hash 路由，无需 SPA fallback）
    // __dirname = <pkgroot>/dist，上一级到 pkgroot，再进 frontend/dist
    const frontendDist = path.resolve(__dirname, '..', 'frontend', 'dist');
    app.use(express.static(frontendDist, { index: 'index.html' }));
  }

  // ---- Catch-all：透传未匹配请求到上游 ----
  // 透明代理核心语义：除 /api、根路径和静态文件外，其余一律原样转发上游。
  // 前端用 hash 路由（createWebHashHistory），路由切换不发请求，故无需 SPA fallback。
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/') return next();
    if (req.method === 'GET' && req.path.includes('.')) return next();
    void handlePassthrough(req, res).catch(error => {
      passthroughLogger.error({
        method: req.method,
        path: req.path,
        err: serializeError(error),
      }, 'passthrough request failed');
      next(error);
    });
  });

  // ---- 启动 ----
  const onStart = () => {
    serverLogger.info({ host: '0.0.0.0', port: PORT, upstream: UPSTREAM_URL }, 'SSEInspector started');
  };
  if (isDev) {
    const ve = require('vite-express');
    const ViteExpress = ve.default ?? ve;
    server = ViteExpress.listen(app, PORT, onStart);
  } else {
    server = app.listen(PORT, onStart);
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  shutdownLogger.info({ signal }, 'shutdown started');
  server?.close(error => {
    if (error) shutdownLogger.error({ err: serializeError(error) }, 'HTTP server shutdown failed');
  });
  server?.closeIdleConnections?.();

  const hardExit = setTimeout(() => {
    shutdownLogger.warn({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'shutdown deadline reached');
    process.exit(0);
  }, SHUTDOWN_TIMEOUT_MS);
  try {
    await stopRecorder(SHUTDOWN_TIMEOUT_MS);
  } catch (error) {
    shutdownLogger.error({ err: serializeError(error) }, 'Recorder Worker shutdown failed');
  } finally {
    clearTimeout(hardExit);
    process.exit(0);
  }
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

start().catch((err) => {
  serverLogger.fatal({ err: serializeError(err) }, 'SSEInspector startup failed');
  process.exit(1);
});
