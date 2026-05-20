const state = {
  requests: [],
  selectedId: null,
  eventSource: null,
  searchQuery: '',
  currentRecord: null,
  renderTimer: null,
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

  es.onerror = () => {};
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
      if (summary.streamText) {
        renderStreamLive(summary.streamText);
      }
    }
  } else {
    state.requests.unshift(summary);
  }

  state.requests.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  if (state.selectedId) {
    updateNavButtons();
  } else {
    if (state.renderTimer) clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(() => {
      state.renderTimer = null;
      renderList();
    }, 300);
  }
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
  document.getElementById('stat-total').textContent = `总计 ${state.requests.length}`;
  document.getElementById('stat-openai').textContent = `OpenAI ${state.requests.filter(r => r.apiType === 'openai').length}`;
  document.getElementById('stat-anthropic').textContent = `Anthropic ${state.requests.filter(r => r.apiType === 'anthropic').length}`;
  document.getElementById('stat-streaming').textContent = `进行中 ${state.requests.filter(r => r.state === 'streaming').length}`;
  document.getElementById('stat-errors').textContent = `错误 ${state.requests.filter(r => r.state === 'error').length}`;
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
    empty.textContent = state.searchQuery ? '无匹配请求' : '暂无记录，发送请求到代理即可看到';
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
      <td class="cell-preview">${isStreaming ? '<em style="color:var(--accent)">流式传输中…</em>' : esc(r.preview)}</td>
      <td class="cell-duration">${isStreaming ? '…' : r.durationMs + 'ms'}</td>
    `;
    tr.addEventListener('click', () => { location.hash = '#detail/' + r.id; });
    tbody.appendChild(tr);
  }
}

// ---- Detail View ----

async function showDetail(id) {
  state.selectedId = id;
  if (state.renderTimer) { clearTimeout(state.renderTimer); state.renderTimer = null; }
  document.getElementById('view-list').style.display = 'none';
  document.getElementById('view-detail').style.display = 'block';

  updateNavButtons();

  const summary = state.requests.find(r => r.id === id);
  if (summary) renderMetaFromSummary(summary);

  document.getElementById('detail-content').innerHTML = '<p style="color:var(--text-secondary)">加载中…</p>';

  await fetchDetail(id);
}

function updateNavButtons() {
  const idx = state.requests.findIndex(r => r.id === state.selectedId);
  const total = state.requests.length;
  document.getElementById('btn-prev').disabled = idx >= total - 1 || idx < 0;
  document.getElementById('btn-next').disabled = idx <= 0;
  document.getElementById('detail-nav-pos').textContent =
    total > 0 ? `${idx + 1} / ${total}` : '';
}

function navigateDetail(delta) {
  const idx = state.requests.findIndex(r => r.id === state.selectedId);
  if (idx < 0) return;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= state.requests.length) return;
  location.hash = '#detail/' + state.requests[newIdx].id;
}

async function fetchDetail(id) {
  const contentDiv = document.getElementById('detail-content');
  try {
    const res = await fetch('/api/requests/' + id);
    if (!res.ok) throw new Error('Not found');
    const record = await res.json();
    renderDetail(record);
  } catch {
    contentDiv.innerHTML = '<p style="color:var(--error)">加载失败</p>';
  }
}

function renderMetaFromSummary(summary) {
  const meta = document.getElementById('detail-meta');
  meta.innerHTML = `
    <span>ID: ${summary.id}</span>
    <span>时间: ${new Date(summary.timestamp).toLocaleString('zh-CN')}</span>
    <span>API: ${apiBadge(summary.apiType)}</span>
    <span>流式: ${summary.streaming ? '是' : '否'}</span>
    <span>耗时: ${summary.state === 'streaming' ? '…' : summary.durationMs + 'ms'}</span>
    ${summary.state === 'streaming' ? '<span style="color:var(--accent);font-weight:600">● 传输中…</span>' : ''}
  `;
}

function renderDetail(record) {
  state.currentRecord = record;
  const statusClass = record.responseStatus < 400 ? 'badge-ok' : (record.responseStatus < 500 ? 'badge-warn' : 'badge-err');
  document.getElementById('detail-meta').innerHTML = `
    <span>ID: ${record.id}</span>
    <span>时间: ${new Date(record.timestamp).toLocaleString('zh-CN')}</span>
    <span>API: ${apiBadge(record.apiType)}</span>
    <span>流式: ${record.streaming ? '是' : '否'}</span>
    <span>耗时: ${record.durationMs}ms</span>
    <span>状态: <span class="badge ${statusClass}">${record.responseStatus}</span></span>
    ${record.error ? `<span style="color:var(--error)">错误: ${esc(record.error)}</span>` : ''}
    ${record.state === 'streaming' ? '<span style="color:var(--accent);font-weight:600">● 传输中…</span>' : ''}
  `;

  document.getElementById('detail-request-url').innerHTML = renderRequestUrl(record);
  document.getElementById('detail-request-headers').innerHTML = renderHeaders(record.requestHeaders, '请求头');
  document.getElementById('detail-request').innerHTML = renderRequestBody(record.requestBody);
  document.getElementById('detail-user-request').innerHTML = renderUserRequest(record.requestBody);

  const contentDiv = document.getElementById('detail-content');

  if (record.state === 'streaming') {
    if (record.streamText) {
      renderStreamLive(record.streamText);
    } else {
      contentDiv.innerHTML = '<p style="color:var(--accent);padding:20px 0;">● 等待第一块数据…</p>';
    }
    document.getElementById('detail-response-body').innerHTML = '';
    document.getElementById('detail-response-headers').innerHTML = '';
    return;
  }

  if (!record.responseContent) {
    contentDiv.innerHTML = '<p style="color:var(--text-secondary)">无响应内容</p>';
  } else if (record.apiType === 'anthropic') {
    contentDiv.innerHTML = renderAnthropicContent(record.responseContent);
  } else {
    contentDiv.innerHTML = renderOpenAIContent(record.responseContent);
  }

  document.getElementById('detail-response-body').innerHTML = renderResponseBody(record.responseBody, record.responseContent);
  document.getElementById('detail-response-headers').innerHTML = renderHeaders(record.responseHeaders, '响应头');
}

function renderOpenAIContent(rc) {
  let html = `<div class="card"><div class="card-title">模型: <span class="kv kv-model">${esc(rc.model || 'unknown')}</span> | 用量: ${formatUsage(rc.usage)}</div></div>`;

  for (const choice of rc.choices || []) {
    const msg = choice.message;
    if (!msg) continue;

    if (msg.reasoning_content) {
      html += `
        <details class="reasoning" open>
          <summary>
            <span class="section-label label-reasoning">推理过程</span>
            ${copyBtnHtml(msg.reasoning_content)}
          </summary>
          <div class="reasoning-content">${esc(msg.reasoning_content)}</div>
        </details>`;
    }

    if (msg.content) {
      html += wrapCopy(`
        <div class="card">
          <span class="section-label label-content">回答</span>
          <div class="message-content">${esc(msg.content)}</div>
        </div>`, msg.content);
    }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      html += `<span class="section-label label-tool">工具调用</span>`;
      for (const tc of msg.tool_calls) {
        const toolName = tc.function?.name || `tool_${tc.index}`;
        let argsDisplay;
        let argsRaw;
        try {
          const parsed = JSON.parse(tc.function.arguments);
          argsDisplay = JSON.stringify(parsed, null, 2);
          argsRaw = argsDisplay;
        } catch {
          argsDisplay = tc.function.arguments || '(无参数)';
          argsRaw = argsDisplay;
        }
        html += `
          <div class="tool-call">
            <div class="tool-header"><span class="tool-name">${esc(toolName)}</span><span class="tool-id">${esc(tc.id || '')}</span></div>
            ${wrapCopy(`${renderJSONViewer(argsRaw)}`, argsRaw)}
          </div>`;
      }
    }

    if (choice.finish_reason) {
      html += `<p style="color:var(--text-secondary);font-size:0.8rem;margin-top:8px;">结束原因: <span class="kv kv-finish kv-finish-${esc(choice.finish_reason)}">${esc(choice.finish_reason)}</span></p>`;
    }
  }
  return html;
}

function renderAnthropicContent(rc) {
  const stopClass = `kv-stop kv-stop-${esc(rc.stop_reason || 'none')}`;
  let html = `<div class="card"><div class="card-title">模型: <span class="kv kv-model">${esc(rc.model || 'unknown')}</span> | 角色: <span class="kv kv-role">${esc(rc.role || '')}</span> | 停止原因: <span class="kv ${stopClass}">${esc(rc.stop_reason || '无')}</span></div></div>`;
  html += `<div class="content-blocks">`;

  for (const block of rc.content || []) {
    switch (block.type) {
      case 'text':
        html += wrapCopy(`
          <div class="anthropic-block text">
            <div class="block-header">文本块 #${block.index}</div>
            <div class="block-body"><div class="message-content">${esc(block.text || '')}</div></div>
          </div>`, block.text || '');
        break;
      case 'thinking':
        html += wrapCopy(`
          <div class="anthropic-block thinking">
            <div class="block-header">思考块 #${block.index}</div>
            <div class="block-body" style="font-family:var(--font-mono);font-size:0.82rem;white-space:pre-wrap;">${esc(block.thinking || '')}</div>
          </div>`, block.thinking || '');
        break;
      case 'tool_use': {
        const inputIsObj = typeof block.input === 'object' && block.input !== null;
        const inputDisplay = inputIsObj ? JSON.stringify(block.input, null, 2) : String(block.input || '{}');
        const inputRaw = inputIsObj ? JSON.stringify(block.input) : String(block.input || '{}');
        html += `
          <div class="anthropic-block tool_use">
            <div class="block-header">工具调用 #${block.index}: <span class="tool-name">${esc(block.name || 'unknown')}</span> <span class="tool-id">(${esc(block.id || '')})</span></div>
            ${wrapCopy(`${inputIsObj ? `<div class="block-body">${renderJSONViewer(inputRaw)}</div>` : `<div class="block-body"><pre>${esc(inputDisplay)}</pre></div>`}`, inputRaw)}
          </div>`;
        break;
      }
    }
  }

  html += `</div>`;
  return html;
}

function extractUserRequest(body) {
  if (!body || !body.messages) return { text: null, toolResults: [] };

  const result = { text: null, toolResults: [] };
  const msgs = body.messages;

  // Find the last user message index
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return result;

  // Extract text + Anthropic tool_result blocks from the last user message
  const userMsg = msgs[lastUserIdx];
  const content = userMsg.content;
  if (typeof content === 'string') {
    result.text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && !result.text) {
        result.text = block.text;
      } else if (block.type === 'tool_result') {
        result.toolResults.push({
          id: block.tool_use_id || '',
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        });
      }
    }
  }

  // Collect OpenAI tool messages that belong to the latest turn:
  // only those after the last assistant message before the last user message
  let scanStart = lastUserIdx - 1;
  for (let i = scanStart; i >= 0; i--) {
    if (msgs[i].role === 'assistant') break;
    if (msgs[i].role === 'tool') {
      result.toolResults.unshift({
        id: msgs[i].tool_call_id || '',
        content: typeof msgs[i].content === 'string' ? msgs[i].content : JSON.stringify(msgs[i].content),
      });
    }
  }

  return result;
}

function renderUserRequest(body) {
  if (!body) return '';
  const ur = extractUserRequest(body);
  if (!ur.text && ur.toolResults.length === 0) return '';

  let html = `<div class="card user-request-card">`;
  html += `<span class="section-label label-user-request">用户请求</span>`;

  if (ur.text) {
    html += wrapCopy(`<div class="message-content">${esc(ur.text)}</div>`, ur.text);
  }

  if (ur.toolResults.length > 0) {
    html += `<div class="tool-results-section">`;
    html += `<div class="tool-results-label">工具调用结果 (${ur.toolResults.length})</div>`;
    for (const tr of ur.toolResults) {
      html += `
        <div class="tool-result-item">
          <div class="tool-result-id">${esc(tr.id)}</div>
          ${wrapCopy(`<pre><code>${esc(tr.content)}</code></pre>`, tr.content)}
        </div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function renderStreamLive(text) {
  const contentDiv = document.getElementById('detail-content');
  let card = contentDiv.querySelector('.streaming-live');
  let pre;

  if (!card) {
    contentDiv.innerHTML = `
      <div class="card streaming-live">
        <span class="section-label label-streaming">实时接收中…</span>
        <pre></pre>
      </div>`;
    card = contentDiv.querySelector('.streaming-live');
  }

  pre = card.querySelector('pre');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  pre.textContent = text;
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

function renderResponseBody(rawBody, mergedContent) {
  if (!rawBody && !mergedContent) return '';

  const uid = 'rb' + Math.random().toString(36).slice(2, 8);
  const mergedText = mergedContent ? JSON.stringify(mergedContent, null, 2) : '';
  const isJson = !rawBody || rawBody.startsWith('{');

  let html = `<details class="headers-viewer response-body-viewer" id="${uid}">`;
  html += `<summary>响应体</summary>`;
  html += `<div class="rb-tabs">`;
  html += `<button class="rb-tab active" onclick="switchRespBody('${uid}','raw')">原始</button>`;
  html += `<button class="rb-tab" onclick="switchRespBody('${uid}','merged')">合并</button>`;
  html += `</div>`;

  // Raw view
  html += `<div class="rb-pane rb-raw" id="${uid}-raw">`;
  html += copyBtnHtml(rawBody || '');
  html += `${isJson && rawBody ? renderJSONViewer(rawBody) : `<pre>${esc(rawBody || '')}</pre>`}`;
  html += `</div>`;

  // Merged view
  html += `<div class="rb-pane rb-merged" id="${uid}-merged" style="display:none">`;
  html += copyBtnHtml(mergedText);
  html += `${renderJSONViewer(mergedText)}`;
  html += `</div>`;

  html += `</details>`;
  return html;
}

window.switchRespBody = function(uid, mode) {
  const container = document.getElementById(uid);
  if (!container) return;
  container.querySelector('.rb-raw').style.display = mode === 'raw' ? '' : 'none';
  container.querySelector('.rb-merged').style.display = mode === 'merged' ? '' : 'none';
  container.querySelectorAll('.rb-tab').forEach((t, i) => {
    t.classList.toggle('active', (i === 0 && mode === 'raw') || (i === 1 && mode === 'merged'));
  });
};

function renderHeaders(headers, title) {
  if (!headers || Object.keys(headers).length === 0) return '';
  const text = JSON.stringify(headers, null, 2);
  return `
    <details class="headers-viewer">
      <summary>
        ${esc(title)}
        ${copyBtnHtml(text)}
      </summary>
      ${renderJSONViewer(text)}
    </details>`;
}

function renderRequestBody(body) {
  if (!body) return '';
  const text = JSON.stringify(body, null, 2);
  return `
    <details class="req-body">
      <summary>
        请求体
        ${copyBtnHtml(text)}
      </summary>
      ${renderJSONViewer(text)}
    </details>`;
}

function renderRequestUrl(record) {
  if (!record.path) return '';
  const proxyCurl = buildCurl(record, record.path);
  const upstreamCurl = record.upstreamUrl ? buildCurl(record, record.upstreamUrl) : '';
  return `
    <div class="request-url-card">
      <div class="card-title">请求地址</div>
      <div class="request-url-row">
        <code class="request-url-text">${esc(record.method)} ${esc(record.path)}</code>
        <button class="copy-btn curl-copy-btn" onclick="copyFromBtn(event)" data-copy="${escAttr(proxyCurl)}" title="复制为 cURL">curl</button>
      </div>
      ${record.upstreamUrl ? `
      <div class="card-title" style="margin-top:10px">代理地址</div>
      <div class="request-url-row">
        <code class="request-url-text">${esc(record.method)} ${esc(record.upstreamUrl)}</code>
        <button class="copy-btn curl-copy-btn" onclick="copyFromBtn(event)" data-copy="${escAttr(upstreamCurl)}" title="复制为 cURL">curl</button>
      </div>` : ''}
    </div>`;
}

function buildCurl(record, url) {
  const headers = record.requestHeaders || {};
  let cmd = `curl -X ${record.method} '${url}'`;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'accept-encoding') continue;
    cmd += ` \\\n  -H '${k}: ${v}'`;
  }
  if (record.requestBody && record.method !== 'GET' && record.method !== 'HEAD') {
    const body = typeof record.requestBody === 'string' ? record.requestBody : JSON.stringify(record.requestBody);
    cmd += ` \\\n  -d '${body.replace(/'/g, "'\\''")}'`;
  }
  return cmd;
}

// ---- Monaco JSON Viewer ----

window._monacoPending = [];
window._monacoEditors = {};

function createMonacoEditor(containerId, jsonStr) {
  const el = document.getElementById(containerId);
  if (!el) return;

  let parsed;
  try { parsed = JSON.parse(jsonStr); } catch { return; }
  const pretty = JSON.stringify(parsed, null, 2);

  // Dispose previous editor on same container
  if (window._monacoEditors[containerId]) {
    window._monacoEditors[containerId].dispose();
  }

  const editor = monaco.editor.create(el, {
    value: pretty,
    language: 'json',
    readOnly: true,
    folding: true,
    minimap: { enabled: false },
    lineNumbers: 'off',
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    automaticLayout: true,
    renderLineHighlight: 'none',
    glyphMargin: false,
    lineDecorationsWidth: 4,
    lineNumbersMinChars: 0,
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    overviewRulerBorder: false,
    scrollbar: { alwaysConsumeMouseWheel: false },
    theme: 'vs',
  });

  editor.onDidContentSizeChange(() => {
    const h = Math.min(editor.getContentHeight(), 500);
    el.style.height = h + 'px';
    editor.layout();
  });

  window._monacoEditors[containerId] = editor;
}

function initMonacoEditors() {
  for (const item of window._monacoPending) {
    createMonacoEditor(item.containerId, item.jsonStr);
  }
  window._monacoPending = [];
}

function renderJSONViewer(jsonStr) {
  let parsed;
  try { parsed = JSON.parse(jsonStr); } catch { return `<pre>${esc(jsonStr)}</pre>`; }
  const id = 'mc' + Math.random().toString(36).slice(2, 8);
  const queue = { containerId: id, jsonStr };
  if (window._monacoReady) {
    setTimeout(() => createMonacoEditor(id, jsonStr), 0);
  } else {
    window._monacoPending.push(queue);
  }
  return `<div class="monaco-json-container" id="${id}"></div>`;
}

// ---- Copy ----

function copyBtnHtml(content) {
  if (!content) return '';
  return `<button class="copy-btn" onclick="copyFromBtn(event)" data-copy="${escAttr(content)}" title="复制"></button>`;
}

function wrapCopy(innerHtml, rawContent) {
  if (!rawContent) return innerHtml;
  return `<div class="copy-wrap">${innerHtml}${copyBtnHtml(rawContent)}</div>`;
}

window.copyFromBtn = async function(event) {
  event.stopPropagation();
  const btn = event.currentTarget;
  const text = btn.getAttribute('data-copy') || '';
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  } catch {
    // fallback for older browsers or insecure context
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  }
};

// ---- Export ----

function formatExport(record) {
  let out = '';

  // Header
  out += `# SSEInspector Export\n`;
  out += `\n`;
  out += `| 字段 | 值 |\n`;
  out += `|------|----|\n`;
  out += `| ID | ${record.id} |\n`;
  out += `| 时间 | ${new Date(record.timestamp).toLocaleString('zh-CN')} |\n`;
  out += `| API | ${record.apiType} |\n`;
  out += `| 模型 | ${record.responseContent?.model ?? 'unknown'} |\n`;
  out += `| 耗时 | ${record.durationMs}ms |\n`;
  out += `| 状态 | ${record.responseStatus} |\n`;
  out += `\n`;

  // User request
  const ur = extractUserRequest(record.requestBody);
  if (ur.text) {
    out += `## 用户请求\n\n${ur.text}\n\n`;
  }
  if (ur.toolResults.length > 0) {
    out += `## 工具调用结果 (${ur.toolResults.length})\n\n`;
    for (const tr of ur.toolResults) {
      out += `### ${tr.id}\n\n\`\`\`\n${tr.content}\n\`\`\`\n\n`;
    }
  }

  // Response
  const rc = record.responseContent;
  if (!rc) return out;

  if (record.apiType === 'anthropic') {
    out += `## 响应\n\n`;
    const content = rc.content || [];
    for (const block of content) {
      switch (block.type) {
        case 'text':
          out += `### 文本块 #${block.index}\n\n${block.text || ''}\n\n`;
          break;
        case 'thinking':
          out += `### 思考块 #${block.index}\n\n\`\`\`\n${block.thinking || ''}\n\`\`\`\n\n`;
          break;
        case 'tool_use': {
          const inputIsObj = typeof block.input === 'object' && block.input !== null;
          const inputStr = inputIsObj ? JSON.stringify(block.input, null, 2) : String(block.input || '{}');
          out += `### 工具调用 #${block.index}: ${block.name || 'unknown'}\n\n\`\`\`json\n${inputStr}\n\`\`\`\n\n`;
          break;
        }
      }
    }
  } else {
    out += `## 响应\n\n`;
    const choices = rc.choices || [];
    for (const choice of choices) {
      const msg = choice.message;
      if (!msg) continue;
      if (msg.reasoning_content) {
        out += `### 推理过程\n\n\`\`\`\n${msg.reasoning_content}\n\`\`\`\n\n`;
      }
      if (msg.content) {
        out += `### 回答\n\n${msg.content}\n\n`;
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        out += `### 工具调用\n\n`;
        for (const tc of msg.tool_calls) {
          const toolName = tc.function?.name || `tool_${tc.index}`;
          let argsStr = tc.function.arguments || '';
          try { argsStr = JSON.stringify(JSON.parse(argsStr), null, 2); } catch { /* keep raw */ }
          out += `#### ${toolName}\n\n\`\`\`json\n${argsStr}\n\`\`\`\n\n`;
        }
      }
    }
  }

  return out;
}

async function doExport() {
  const record = state.currentRecord;
  if (!record) return;
  const text = formatExport(record);
  const btn = document.getElementById('btn-export');
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  }
}

// ---- Helpers ----

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function statusBadge(code) {
  if (code < 300) return `<span class="badge badge-ok">${code}</span>`;
  if (code < 500) return `<span class="badge badge-warn">${code}</span>`;
  return `<span class="badge badge-err">${code}</span>`;
}

function streamingBadge() {
  return `<span class="badge badge-streaming">传输中</span>`;
}

function apiBadge(type) {
  if (type === 'anthropic') return `<span class="badge badge-anthropic">Anthropic</span>`;
  return `<span class="badge badge-openai">OpenAI</span>`;
}

function formatUsage(usage) {
  if (!usage) return 'N/A';
  if (usage.input_tokens !== undefined) return `输入 ${usage.input_tokens} + 输出 ${usage.output_tokens}`;
  return `提示 ${usage.prompt_tokens || 0} + 生成 ${usage.completion_tokens || 0} = 总计 ${usage.total_tokens || 0}`;
}

function esc(s) {
  if (typeof s !== 'string') return String(s);
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- Init ----

document.addEventListener('DOMContentLoaded', () => {
  handleRoute();
  fetchInitial();
  connectSSE();

  document.getElementById('btn-back').addEventListener('click', () => {
    location.hash = 'list';
  });

  document.getElementById('btn-prev').addEventListener('click', () => {
    navigateDetail(1);
  });

  document.getElementById('btn-next').addEventListener('click', () => {
    navigateDetail(-1);
  });

  document.getElementById('btn-export').addEventListener('click', doExport);

  document.addEventListener('keydown', (e) => {
    if (!state.selectedId) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft') navigateDetail(1);
    if (e.key === 'ArrowRight') navigateDetail(-1);
  });

  document.getElementById('btn-clear').addEventListener('click', async () => {
    if (!confirm('确认清空全部记录？')) return;
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
