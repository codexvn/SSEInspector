import 'reflect-metadata';
import express from 'express';
import compression from 'compression';
import path from 'path';
import { handleProxy, handlePassthrough } from './proxy';
import { getAll, getById, getPrevInSession, getNextInSession, getStats, getGlobalNeighbors, onUpdate, getToolCalls, getToolCallPair } from './store';
import { resolveTokenizer } from './token-registry';
import { initDb } from './db';
import { config } from './config';
import { RecordSummary, RequestListFilter } from './types';

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

if (!UPSTREAM_URL) {
  console.error('Error: 上游地址未配置。');
  console.error('  请通过 CLI 启动: sse-inspector --upstream http://localhost:8000 --db-path ./data.db');
  console.error('  开发模式: npm start -- --upstream http://localhost:8000 --db-path ./data.db');
  process.exit(1);
}

/** 包装 async handler：任意 reject 自动 → 500 + 打印日志 */
function route(fn: (req: express.Request, res: express.Response) => Promise<void>) {
  return (req: express.Request, res: express.Response) => {
    fn(req, res).catch((err) => {
      console.error(`[api] ${req.method} ${req.path} 失败: ${formatErrorChain(err)}`);
      if (!res.headersSent) res.status(500).json({ error: '服务器内部错误' });
    });
  };
}

function formatErrorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current) {
    if (current instanceof Error) {
      messages.push(`${current.name}: ${current.message}`);
      current = current.cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  return messages.join(' -> ');
}

function parseRequestListFilter(value: unknown): RequestListFilter {
  const allowedFilters: RequestListFilter[] = ['all', 'openai', 'anthropic', 'streaming', 'error'];
  return allowedFilters.includes(value as RequestListFilter) ? value as RequestListFilter : 'all';
}

async function start() {
  await initDb();
  const app = express();

  app.use(compression({
    // SSE 响应不压缩：压缩流会缓冲小块数据，导致 /api/events 推送不及时
    filter: (req, res) => {
      const type = res.getHeader('Content-Type');
      if (typeof type === 'string' && type.includes('text/event-stream')) return false;
      return compression.filter(req, res);
    },
  }));

  // 仅 /api 路由需要解析 JSON body（如 /api/tokenize 读 req.body）。
  // 代理路由（/chat/completions、/responses、/messages）与 catch-all 透传必须保持原始请求体，
  // 不得经过任何 body 消费型中间件——否则压缩请求体（gzip/deflate/br/zstd）会被消费破坏透明性，
  // body-parser 也会对不支持的编码（如 zstd）抛 UnsupportedMediaTypeError。原始请求体读取见 proxy.ts readRawBody。
  app.use('/api', express.json({ limit: '10mb' }));

  // ---- API 路由 ----

  app.get('/api/requests', route(async (req, res) => {
    const page = parseInt(req.query.page as string) || undefined;
    const pageSize = parseInt(req.query.pageSize as string) || undefined;
    const filter = parseRequestListFilter(req.query.filter);
    // 可选会话维度过滤，与类别 filter 正交组合
    const sessionIdRaw = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : '';
    const sessionId = sessionIdRaw || undefined;
    res.json(await getAll(page, pageSize, filter, sessionId));
  }));

  app.get('/api/requests/:id', route(async (req, res) => {
    const record = await getById(req.params.id);
    if (!record) {
      console.warn(`[api] request not found: ${req.params.id}`);
      res.status(404).json({ error: 'Request not found' });
      return;
    }
    res.json(record);
  }));

  // 同一会话中指定请求的上一条 / 下一条
  app.get('/api/requests/:id/prev', route(async (req, res) => {
    const cur = await getById(req.params.id);
    if (!cur || !cur.sessionId) { res.json(null); return; }
    const prev = await getPrevInSession(req.params.id, cur.sessionId);
    res.json(prev ?? null);
  }));

  app.get('/api/requests/:id/next', route(async (req, res) => {
    const cur = await getById(req.params.id);
    if (!cur || !cur.sessionId) { res.json(null); return; }
    const next = await getNextInSession(req.params.id, cur.sessionId);
    res.json(next ?? null);
  }));

  app.get('/api/stats', route(async (_req, res) => {
    res.json(await getStats());
  }));

  app.get('/api/requests/:id/neighbors', route(async (req, res) => {
    res.json(await getGlobalNeighbors(req.params.id));
  }));

  // token 计数：复用 resolveTokenizer 路由（OpenAI/Claude/HF），供前端流式实时速度估算
  app.post('/api/tokenize', route(async (req, res) => {
    const { text, model } = req.body as { text?: string; model?: string };
    if (typeof text !== 'string' || typeof model !== 'string') {
      res.status(400).json({ error: '需要 text 和 model 字段' });
      return;
    }
    const tokenizer = await resolveTokenizer(model);
    const count = tokenizer ? tokenizer.encoder(text) : 0;
    res.json({ count, source: tokenizer?.source ?? null });
  }));

  // SSE events stream
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const removeUpdate = onUpdate((summary: RecordSummary) => {
      res.write(`data: ${JSON.stringify({ type: 'update', record: summary })}\n\n`);
    });

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      removeUpdate();
    });
  });

  app.get('/api/tool-calls', route(async (req, res) => {
    const requestId = req.query.requestId as string;
    const toolName = req.query.toolName as string;
    const toolCallId = req.query.toolCallId as string;
    if (toolName && toolCallId) {
      res.json(await getToolCallPair(toolName, toolCallId));
    } else if (requestId) {
      res.json({ toolCalls: await getToolCalls(requestId) });
    } else {
      res.status(400).json({ error: 'Need requestId or toolName+toolCallId' });
    }
  }));

  // ---- Proxy 路由 ----

  app.post(/\/chat\/completions$/, (req, res) => handleProxy(req, res, 'openai', 'openai-chat'));
  app.post(/\/responses$/, (req, res) => handleProxy(req, res, 'openai', 'openai-responses'));
  app.post(/\/messages$/, (req, res) => handleProxy(req, res, 'anthropic', 'anthropic-messages'));

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
    handlePassthrough(req, res);
  });

  // ---- 启动 ----
  const onStart = () => {
    console.log(`SSEInspector running on http://0.0.0.0:${PORT}`);
    console.log(`Proxying to ${UPSTREAM_URL}`);
  };
  if (isDev) {
    const ve = require('vite-express');
    const ViteExpress = ve.default ?? ve;
    ViteExpress.listen(app, PORT, onStart);
  } else {
    app.listen(PORT, onStart);
  }
}

start().catch((err) => {
  console.error('[启动失败]', err);
  process.exit(1);
});
