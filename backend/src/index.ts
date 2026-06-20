import 'reflect-metadata';
import express from 'express';
import compression from 'compression';
import path from 'path';
import ViteExpress from 'vite-express';
import { handleProxy, handlePassthrough } from './proxy';
import { getAll, getById, getPrevInSession, getNextInSession, getStats, getGlobalNeighbors, onUpdate, getToolCalls, getToolCallPair } from './store';
import { resolveTokenizer } from './token-registry';
import { initDb } from './db';
import { RecordSummary, RequestListFilter } from './types';

const PORT = parseInt(process.env.PORT || '3000', 10);
const UPSTREAM_URL = process.env.UPSTREAM_URL;

if (!UPSTREAM_URL) {
  console.error('Error: UPSTREAM_URL environment variable is required.');
  console.error('Example: UPSTREAM_URL=http://localhost:8000 npm start');
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

  app.use(express.json({ limit: '10mb' }));

  // ---- API 路由 ----

  app.get('/api/requests', route(async (req, res) => {
    const page = parseInt(req.query.page as string) || undefined;
    const pageSize = parseInt(req.query.pageSize as string) || undefined;
    const filter = parseRequestListFilter(req.query.filter);
    res.json(await getAll(page, pageSize, filter));
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

  // ---- 前端静态资源（vite-express：dev HMR / prod static）----

  const frontRoot = path.resolve(__dirname, '..', '..', 'frontend');
  ViteExpress.config({ inlineViteConfig: { root: frontRoot } });
  app.use(ViteExpress.static());

  // ---- Catch-all：透传未匹配请求到上游 ----（在 ViteExpress.static 之后注册）

  app.use((req, res, next) => {
    // Skip inspector API (already handled) and root (SPA fallback)
    if (req.path.startsWith('/api/') || req.path === '/') return next();
    // Skip static file requests
    if (req.method === 'GET' && req.path.includes('.')) return next();
    handlePassthrough(req, res);
  });

  // ---- 启动 ----

  ViteExpress.listen(app, PORT, () => {
    console.log(`SSEInspector running on http://0.0.0.0:${PORT}`);
    console.log(`Proxying to ${UPSTREAM_URL}`);
  });
}

start().catch((err) => {
  console.error('[启动失败]', err);
  process.exit(1);
});
