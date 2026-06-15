import 'reflect-metadata';
import express from 'express';
import path from 'path';
import { handleProxy, handlePassthrough } from './proxy';
import { getAll, getById, clear, onUpdate, onClear, getToolCalls, getToolCallPair } from './store';
import { initDb } from './db';
import { RecordSummary } from './types';

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
      console.error(`[api] ${req.method} ${req.path} 失败: ${(err as Error).message}`);
      if (!res.headersSent) res.status(500).json({ error: '服务器内部错误' });
    });
  };
}

const app = express();

app.use(express.json({ limit: '10mb' }));

// Static frontend
const publicDir = path.resolve(__dirname, '..', '..', 'frontend');
app.use(express.static(publicDir));

// API: recorded requests（可选分页）
app.get('/api/requests', route(async (req, res) => {
  const page = parseInt(req.query.page as string) || undefined;
  const pageSize = parseInt(req.query.pageSize as string) || undefined;
  res.json(await getAll(page, pageSize));
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

app.delete('/api/requests', route(async (_req, res) => {
  await clear();
  res.status(204).send();
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

  const removeClear = onClear(() => {
    res.write(`data: ${JSON.stringify({ type: 'clear' })}\n\n`);
  });

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeUpdate();
    removeClear();
  });
});

// API: 工具调用查询
app.get('/api/tool-calls', route(async (req, res) => {
  const requestId = req.query.requestId as string;
  const toolName = req.query.toolName as string;
  const toolCallId = req.query.toolCallId as string;
  if (requestId && toolName && toolCallId) {
    res.json(await getToolCallPair(toolName, toolCallId));
  } else if (requestId) {
    res.json({ toolCalls: await getToolCalls(requestId) });
  } else {
    res.status(400).json({ error: 'Need requestId' });
  }
}));

// Proxy: OpenAI-compatible（任何以 /chat/completions 结尾的 POST 请求）
app.post(/\/chat\/completions$/, (req, res) => handleProxy(req, res, 'openai'));

// Proxy: OpenAI Responses API（任何以 /responses 结尾的 POST 请求）
app.post(/\/responses$/, (req, res) => handleProxy(req, res, 'openai'));

// Proxy: Anthropic（任何以 /messages 结尾的 POST 请求）
app.post(/\/messages$/, (req, res) => handleProxy(req, res, 'anthropic'));

// Catch-all: proxy unmatched requests to upstream
app.use((req, res, next) => {
  // Skip inspector API (already handled) and root (served by static)
  if (req.path.startsWith('/api/') || req.path === '/') return next();
  // Skip static file requests
  if (req.method === 'GET' && req.path.includes('.')) return next();
  handlePassthrough(req, res);
});

initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SSEInspector running on http://0.0.0.0:${PORT}`);
    console.log(`Proxying to ${UPSTREAM_URL}`);
  });
}).catch((err) => {
  console.error('[db] 数据库初始化失败:', err);
  process.exit(1);
});
