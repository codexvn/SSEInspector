import express from 'express';
import path from 'path';
import { handleProxy, handlePassthrough } from './proxy';
import { getAll, getById, clear, onUpdate, onClear } from './store';
import { RecordSummary } from './types';

const PORT = parseInt(process.env.PORT || '3000', 10);
const UPSTREAM_URL = process.env.UPSTREAM_URL;

if (!UPSTREAM_URL) {
  console.error('Error: UPSTREAM_URL environment variable is required.');
  console.error('Example: UPSTREAM_URL=http://localhost:8000 npm start');
  process.exit(1);
}

const app = express();

app.use(express.json({ limit: '10mb' }));

// Static frontend
const publicDir = path.resolve(__dirname, '..', 'public');
app.use(express.static(publicDir));

// API: recorded requests
app.get('/api/requests', (_req, res) => {
  res.json(getAll());
});

app.get('/api/requests/:id', (req, res) => {
  const record = getById(req.params.id);
  if (!record) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }
  res.json(record);
});

app.delete('/api/requests', (_req, res) => {
  clear();
  res.status(204).send();
});

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

// Proxy: OpenAI-compatible
app.post('/v1/chat/completions', (req, res) => handleProxy(req, res, 'openai'));

// Proxy: Anthropic
app.post('/v1/messages', (req, res) => handleProxy(req, res, 'anthropic'));

// Catch-all: proxy unmatched requests to upstream
app.use((req, res, next) => {
  // Skip inspector API (already handled) and root (served by static)
  if (req.path.startsWith('/api/') || req.path === '/') return next();
  // Skip static file requests
  if (req.method === 'GET' && req.path.includes('.')) return next();
  console.log(`[passthrough] ${req.method} ${req.path}`);
  handlePassthrough(req, res);
});

app.listen(PORT, () => {
  console.log(`SSEInspector running on http://localhost:${PORT}`);
  console.log(`Proxying to ${UPSTREAM_URL}`);
});
