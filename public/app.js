const state = {
  requests: [],
  selectedId: null,
  eventSource: null,
  searchQuery: '',
};

// ---- Routing ----

function handleRoute() {
  const hash = location.hash;
  const detailMatch = hash.match(/^#detail\/(.+)$/);
  if (detailMatch) {
    showDetail(detailMatch[1]);
  } else {
    showList();
  }
}
window.addEventListener('hashchange', handleRoute);

// ---- SSE ----

function connectSSE() {
  const es = new EventSource('/api/events');
  state.eventSource = es;

  es.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'update') {
        upsertLocal(msg.record);
      } else if (msg.type === 'clear') {
        state.requests = [];
        if (!state.selectedId) renderList();
        updateStats();
      }
    } catch { /* ignore */ }
  });

  es.onerror = () => {}; // auto-reconnects
}

function upsertLocal(summary) {
  const idx = state.requests.findIndex(r => r.id === summary.id);
  if (idx >= 0) {
    const wasStreaming = state.requests[idx].state === 'streaming';
    state.requests[idx] = summary;
    if (wasStreaming && summary.state === 'done' && state.selectedId === summary.id) {
      fetchDetail(summary.id);
    }
    if (state.selectedId === summary.id) {
      renderMetaFromSummary(summary);
    }
  } else {
    state.requests.unshift(summary);
  }

  state.requests.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  if (!state.selectedId) renderList();
  updateStats();
}

async function fetchInitial() {
  try {
    const res = await fetch('/api/requests');
    state.requests = await res.json();
    if (!state.selectedId) renderList();
    updateStats();
  } catch {
    setTimeout(fetchInitial, 1000);
  }
}

// ---- Stats ----

function updateStats() {
  document.getElementById('stat-total').textContent = `Total: ${state.requests.length}`;
  document.getElementById('stat-openai').textContent = `OpenAI: ${state.requests.filter(r => r.apiType === 'openai').length}`;
  document.getElementById('stat-anthropic').textContent = `Anthropic: ${state.requests.filter(r => r.apiType === 'anthropic').length}`;
  document.getElementById('stat-streaming').textContent = `Active: ${state.requests.filter(r => r.state === 'streaming').length}`;
  document.getElementById('stat-errors').textContent = `Errors: ${state.requests.filter(r => r.state === 'error').length}`;
}

// ---- List View ----

function showList() {
  state.selectedId = null;
  location.hash = 'list';
  document.getElementById('view-list').style.display = 'block';
  document.getElementById('view-detail').style.display = 'none';
  renderList();
}

function filteredRequests() {
  const q = state.searchQuery.toLowerCase().trim();
  if (!q) return state.requests;
  return state.requests.filter(r => {
    return (
      r.model.toLowerCase().includes(q) ||
      r.preview.toLowerCase().includes(q) ||
      r.apiType.includes(q) ||
      String(r.status).includes(q)
    );
  });
}

function renderList() {
  const tbody = document.getElementById('requests-tbody');
  const empty = document.getElementById('empty-state');
  tbody.innerHTML = '';

  const items = filteredRequests();

  if (items.length === 0) {
    empty.style.display = 'block';
    empty.textContent = state.searchQuery ? 'No matching requests.' : 'No requests recorded yet. Send a request to the proxy.';
    document.getElementById('requests-table').style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  document.getElementById('requests-table').style.display = '';

  for (const r of items) {
    const tr = document.createElement('tr');
    const isStreaming = r.state === 'streaming';
    tr.innerHTML = `
      <td class="cell-time">${formatTime(r.timestamp)}</td>
      <td class="cell-api">${apiBadge(r.apiType)}</td>
      <td class="cell-model" title="${esc(r.model)}">${esc(r.model)}</td>
      <td>${isStreaming ? streamingBadge() : statusBadge(r.status)}</td>
      <td class="cell-preview">${isStreaming ? '<em style="color:var(--accent)">streaming...</em>' : esc(r.preview)}</td>
      <td class="cell-duration">${isStreaming ? '...' : r.durationMs + 'ms'}</td>
    `;
    if (!isStreaming) {
      tr.addEventListener('click', () => { location.hash = '#detail/' + r.id; });
    }
    tbody.appendChild(tr);
  }
}

// ---- Detail View ----

async function showDetail(id) {
  state.selectedId = id;
  document.getElementById('view-list').style.display = 'none';
  document.getElementById('view-detail').style.display = 'block';

  const summary = state.requests.find(r => r.id === id);
  if (summary) renderMetaFromSummary(summary);

  document.getElementById('detail-content').innerHTML = '<p style="color:var(--text-secondary)">Loading...</p>';
  document.getElementById('detail-chunks').innerHTML = '';

  await fetchDetail(id);
}

async function fetchDetail(id) {
  const contentDiv = document.getElementById('detail-content');
  try {
    const res = await fetch('/api/requests/' + id);
    if (!res.ok) throw new Error('Not found');
    const record = await res.json();
    renderDetail(record);
  } catch {
    contentDiv.innerHTML = '<p style="color:var(--error)">Failed to load request.</p>';
  }
}

function renderMetaFromSummary(summary) {
  const meta = document.getElementById('detail-meta');
  meta.innerHTML = `
    <span>ID: ${summary.id}</span>
    <span>Time: ${new Date(summary.timestamp).toLocaleString()}</span>
    <span>API: ${apiBadge(summary.apiType)}</span>
    <span>Streaming: ${summary.streaming}</span>
    <span>Duration: ${summary.state === 'streaming' ? '...' : summary.durationMs + 'ms'}</span>
    ${summary.state === 'streaming' ? '<span style="color:var(--accent);font-weight:600">● Streaming...</span>' : ''}
  `;
}

function renderDetail(record) {
  // Meta
  const statusClass = record.responseStatus < 400 ? 'badge-ok' : (record.responseStatus < 500 ? 'badge-warn' : 'badge-err');
  document.getElementById('detail-meta').innerHTML = `
    <span>ID: ${record.id}</span>
    <span>Time: ${new Date(record.timestamp).toLocaleString()}</span>
    <span>API: ${apiBadge(record.apiType)}</span>
    <span>Streaming: ${record.streaming}</span>
    <span>Duration: ${record.durationMs}ms</span>
    <span>Status: <span class="badge ${statusClass}">${record.responseStatus}</span></span>
    ${record.error ? `<span style="color:var(--error)">Error: ${esc(record.error)}</span>` : ''}
    ${record.state === 'streaming' ? '<span style="color:var(--accent);font-weight:600">● Streaming...</span>' : ''}
  `;

  // Request body
  document.getElementById('detail-request').innerHTML = renderRequestBody(record.requestBody);

  // Response content
  const contentDiv = document.getElementById('detail-content');

  if (record.state === 'streaming') {
    contentDiv.innerHTML = '<p style="color:var(--accent);padding:20px 0;">● Waiting for response to complete...</p>';
    document.getElementById('detail-chunks').innerHTML = '';
    return;
  }

  if (!record.responseContent) {
    contentDiv.innerHTML = '<p style="color:var(--text-secondary)">No response content</p>';
  } else if (record.apiType === 'anthropic') {
    contentDiv.innerHTML = renderAnthropicContent(record.responseContent);
  } else {
    contentDiv.innerHTML = renderOpenAIContent(record.responseContent);
  }

  // Chunks
  document.getElementById('detail-chunks').innerHTML = renderChunks(record.chunks, record.apiType);
}

function renderOpenAIContent(rc) {
  let html = `<div class="card"><div class="card-title">Model: ${esc(rc.model || 'unknown')} | Usage: ${formatUsage(rc.usage)}</div></div>`;

  for (const choice of rc.choices || []) {
    const msg = choice.message;
    if (!msg) continue;

    if (msg.reasoning_content) {
      html += `
        <details class="reasoning" open>
          <summary><span class="section-label label-reasoning">Reasoning</span></summary>
          <div class="reasoning-content">${esc(msg.reasoning_content)}</div>
        </details>`;
    }

    if (msg.content) {
      html += `
        <div class="card">
          <span class="section-label label-content">Response</span>
          <div class="message-content">${esc(msg.content)}</div>
        </div>`;
    }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      html += `<span class="section-label label-tool">Tool Calls</span>`;
      for (const tc of msg.tool_calls) {
        const toolName = tc.function?.name || `tool_${tc.index}`;
        let argsDisplay;
        try {
          argsDisplay = JSON.stringify(JSON.parse(tc.function.arguments), null, 2);
        } catch {
          argsDisplay = tc.function.arguments || '(empty)';
        }
        html += `
          <div class="tool-call">
            <div class="tool-header">${esc(toolName)}<span class="tool-id">${esc(tc.id || '')}</span></div>
            <pre><code>${esc(argsDisplay)}</code></pre>
          </div>`;
      }
    }

    if (choice.finish_reason) {
      html += `<p style="color:var(--text-secondary);font-size:0.8rem;margin-top:8px;">Finish: ${esc(choice.finish_reason)}</p>`;
    }
  }
  return html;
}

function renderAnthropicContent(rc) {
  let html = `<div class="card"><div class="card-title">Model: ${esc(rc.model || 'unknown')} | Role: ${esc(rc.role || '')} | Stop: ${esc(rc.stop_reason || 'none')}</div></div>`;
  html += `<div class="content-blocks">`;

  for (const block of rc.content || []) {
    switch (block.type) {
      case 'text':
        html += `
          <div class="anthropic-block text">
            <div class="block-header">Text Block #${block.index}</div>
            <div class="block-body"><div class="message-content">${esc(block.text || '')}</div></div>
          </div>`;
        break;
      case 'thinking':
        html += `
          <div class="anthropic-block thinking">
            <div class="block-header">Thinking Block #${block.index}</div>
            <div class="block-body" style="font-family:var(--font-mono);font-size:0.82rem;white-space:pre-wrap;">${esc(block.thinking || '')}</div>
          </div>`;
        break;
      case 'tool_use':
        let inputDisplay;
        if (typeof block.input === 'object' && block.input !== null) {
          inputDisplay = JSON.stringify(block.input, null, 2);
        } else {
          inputDisplay = String(block.input || '{}');
        }
        html += `
          <div class="anthropic-block tool_use">
            <div class="block-header">Tool Use #${block.index}: ${esc(block.name || 'unknown')} (${esc(block.id || '')})</div>
            <div class="block-body"><pre style="font-family:var(--font-mono);font-size:0.8rem;white-space:pre-wrap;">${esc(inputDisplay)}</pre></div>
          </div>`;
        break;
    }
  }

  html += `</div>`;
  return html;
}

function renderChunks(chunks, apiType) {
  if (!chunks || chunks.length === 0) return '';

  // Generate unique id base for this chunks group
  const uid = 'c' + Math.random().toString(36).slice(2, 8);

  let html = `
    <details class="chunks-viewer">
      <summary>Raw SSE Chunks (${chunks.length})</summary>
      <div class="chunks-list">`;

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const eventLabel = c.event || '-';
    const dataStr = typeof c.data === 'string' ? c.data : JSON.stringify(c.data);
    const prettyStr = typeof c.data === 'string' ? c.data : JSON.stringify(c.data, null, 2);
    const oneLine = dataStr.length > 100 ? dataStr.slice(0, 100) + '...' : dataStr;
    const chunkId = `${uid}-${i}`;

    html += `
      <div class="chunk-row" id="${chunkId}" onclick="toggleChunk('${chunkId}')">
        <span class="chunk-index">#${i + 1}</span>
        <span class="chunk-event">${esc(eventLabel)}</span>
        <code class="chunk-oneline">${esc(oneLine)}</code>
        <code class="chunk-full" style="display:none">${esc(prettyStr)}</code>
      </div>`;
  }

  html += `</div></details>`;
  return html;
}

function renderRequestBody(body) {
  if (!body) return '';
  const text = JSON.stringify(body, null, 2);
  return `
    <details class="req-body">
      <summary>Request Body</summary>
      <pre>${esc(text)}</pre>
    </details>`;
}

// ---- Helpers ----

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function statusBadge(code) {
  if (code < 300) return `<span class="badge badge-ok">${code}</span>`;
  if (code < 500) return `<span class="badge badge-warn">${code}</span>`;
  return `<span class="badge badge-err">${code}</span>`;
}

function streamingBadge() {
  return `<span class="badge badge-streaming">streaming</span>`;
}

function apiBadge(type) {
  if (type === 'anthropic') return `<span class="badge badge-anthropic">Anthropic</span>`;
  return `<span class="badge badge-openai">OpenAI</span>`;
}

function formatUsage(usage) {
  if (!usage) return 'N/A';
  if (usage.input_tokens !== undefined) return `${usage.input_tokens}I + ${usage.output_tokens}O`;
  return `${usage.prompt_tokens || 0}P + ${usage.completion_tokens || 0}C = ${usage.total_tokens || 0}T`;
}

function esc(s) {
  if (typeof s !== 'string') return String(s);
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

window.toggleChunk = function(chunkId) {
  const row = document.getElementById(chunkId);
  if (!row) return;
  const oneline = row.querySelector('.chunk-oneline');
  const full = row.querySelector('.chunk-full');
  if (!oneline || !full) return;
  if (full.style.display === 'none') {
    oneline.style.display = 'none';
    full.style.display = '';
    row.classList.add('expanded');
  } else {
    oneline.style.display = '';
    full.style.display = 'none';
    row.classList.remove('expanded');
  }
};

// ---- Init ----

document.addEventListener('DOMContentLoaded', () => {
  handleRoute();
  fetchInitial();
  connectSSE();

  document.getElementById('btn-back').addEventListener('click', () => {
    location.hash = 'list';
  });

  document.getElementById('btn-clear').addEventListener('click', async () => {
    if (!confirm('Clear all recorded requests?')) return;
    await fetch('/api/requests', { method: 'DELETE' });
    state.requests = [];
    renderList();
    updateStats();
  });

  document.getElementById('search-input').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    if (!state.selectedId) renderList();
  });
});
