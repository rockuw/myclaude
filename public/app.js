'use strict';
/* myclaude frontend — vanilla JS SPA over WebSocket */

// ---------------- helpers ----------------
const $ = s => document.querySelector(s);
function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3200);
}
function fmtClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function fmtRel(ms) {
  const diff = Date.now() - ms;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  const d = new Date(ms), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return fmtClock(ms);
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return '昨天 ' + fmtClock(ms);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}
function shortPath(p) {
  if (!p) return '';
  return p.replace(/^\/home\/[^/]+/, '~');
}
function copyText(text, btn) {
  const done = () => { const old = btn.textContent; btn.textContent = '已复制 ✓'; setTimeout(() => btn.textContent = old, 1200); };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallback());
  } else fallback();
  function fallback() {
    const ta = el('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch {}
    ta.remove();
  }
}

// ---------------- markdown ----------------
marked.setOptions({ gfm: true, breaks: true });
function renderMarkdown(text) {
  const clean = DOMPurify.sanitize(marked.parse(text || ''), { ADD_ATTR: ['target'] });
  const div = el('div', 'md', clean);
  div.querySelectorAll('pre > code').forEach(code => {
    const pre = code.parentElement;
    const lang = (code.className.match(/language-([\w+-]+)/) || [])[1] || '';
    try { hljs.highlightElement(code); } catch {}
    const wrap = el('div', 'codeblock');
    const head = el('div', 'codeblock-head');
    head.appendChild(el('span', 'codeblock-lang', esc(lang || 'code')));
    const btn = el('button', 'codeblock-copy', '复制');
    btn.type = 'button';
    btn.onclick = () => copyText(code.textContent, btn);
    head.appendChild(btn);
    pre.replaceWith(wrap);
    wrap.appendChild(head); wrap.appendChild(pre);
  });
  div.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  return div;
}

// ---------------- state ----------------
let ws = null, wsRetry = 0;
let settingsCache = null, dirsCache = null;
let sessionsData = { active: [], history: [] };
let current = null;   // {id, info, readOnly, meta}
let S = null;         // per-chat render state

const MODE_LABEL = { bypassPermissions: '跳过权限', acceptEdits: '接受编辑', manual: '每次询问', default: '每次询问', plan: '计划模式', auto: '自动', dontAsk: '不询问' };
const STATUS_LABEL = { starting: '启动中', idle: '空闲', running: '运行中', waiting_permission: '等待授权', exited: '已退出', error: '错误' };
const TOOL_ICON = { Bash: '>_', Read: '📄', Write: '✎', Edit: '✎', Grep: '🔍', Glob: '🗂', Task: '🤖', Agent: '🤖', WebSearch: '🌐', WebFetch: '🌐', TodoWrite: '☑', NotebookEdit: '📓', LSP: '⌘' };
const TOOL_COLOR = { Bash: 'chip-lime', Read: 'chip-cyan', Write: 'chip-orange', Edit: 'chip-orange', Grep: 'chip-lavender', Glob: 'chip-lavender', Task: 'chip-pink', Agent: 'chip-pink', WebSearch: 'chip-cyan', WebFetch: 'chip-cyan', TodoWrite: 'chip-yellow' };

// ---------------- websocket ----------------
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => {
    wsRetry = 0;
    $('#conn-dot').classList.remove('off');
    $('#conn-label').textContent = '已连接';
    if (current && !current.readOnly) sendWS({ t: 'attach', id: current.id });
    refreshSessions();
  };
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    handleWS(m);
  };
  ws.onclose = () => {
    $('#conn-dot').classList.add('off');
    $('#conn-label').textContent = '重连中';
    setTimeout(connect, Math.min(6000, 600 * Math.pow(1.6, wsRetry++)));
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
function sendWS(obj) {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
  toast('连接已断开，正在重连…');
  return false;
}
function handleWS(m) {
  switch (m.t) {
    case 'hello':
      sessionsData.active = m.active || [];
      renderHome();
      break;
    case 'sessions':
      sessionsData.active = m.active || [];
      renderHome();
      if (current && !current.readOnly) {
        const info = sessionsData.active.find(a => a.id === current.id);
        if (info) { current.info = info; updateChatHeader(); }
      }
      break;
    case 'created':
      current = { id: m.session.id, info: m.session, readOnly: false };
      enterChatView();
      resetChat();
      loadHistoryThenAttach(m.session.id);
      break;
    case 'attached':
      if (!current || current.id !== m.session.id) break;
      current.info = m.session;
      updateChatHeader();
      hideLoading();
      for (const ev of m.events) renderEvent(ev);
      afterRender();
      break;
    case 'detached':
      if (current && current.id === m.id) switchToReadOnly(m.id);
      break;
    case 'event':
      if (current && current.id === m.id) { renderEvent(m.ev); afterRender(); }
      break;
    case 'error':
      toast(m.message || '出错了');
      if (current && m.id === current.id) {
        hideLoading();
        const b = appendBanner('error', '⚠ ' + m.message);
        if (/强制恢复/.test(m.message || '')) {
          const btn = el('button', 'btn btn-sm btn-orange', '强制恢复');
          btn.onclick = () => resumeSession(m.id, null, true);
          b.appendChild(btn);
        }
      }
      break;
  }
}

// ---------------- data ----------------
async function refreshSessions() {
  try {
    const r = await fetch('/api/sessions');
    sessionsData = await r.json();
    renderHome();
    if (current && !current.readOnly) {
      const info = sessionsData.active.find(a => a.id === current.id);
      if (info) { current.info = info; updateChatHeader(); }
    }
  } catch {}
}
async function loadSettings() {
  if (!settingsCache) settingsCache = await (await fetch('/api/settings')).json();
  return settingsCache;
}
async function loadDirs() {
  if (!dirsCache) dirsCache = await (await fetch('/api/dirs')).json();
  return dirsCache;
}

// ---------------- home ----------------
function renderHome() {
  const activeBox = $('#active-section');
  activeBox.innerHTML = '';
  const active = sessionsData.active || [];
  if (active.length) {
    activeBox.appendChild(el('div', 'section-title', '进行中 · ' + active.length));
    for (const s of active) activeBox.appendChild(activeCard(s));
  }
  const list = $('#history-list');
  list.innerHTML = '';
  const hist = (sessionsData.history || []).filter(h => !active.some(a => a.id === h.id));
  if (!hist.length) { list.appendChild(el('div', 'empty-note', '还没有历史会话，点击「新建会话」开始')); return; }
  let lastGroup = '';
  for (const h of hist) {
    const g = groupOf(h.mtime);
    if (g !== lastGroup) { list.appendChild(el('div', 'section-title', g)); lastGroup = g; }
    list.appendChild(historyCard(h));
  }
}
function groupOf(ms) {
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return '今天';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '昨天';
  if (now - ms < 7 * 86400e3) return '本周';
  return '更早';
}
function statusDot(status) { return el('span', 'dot dot-' + (status || 'exited')); }
function activeCard(s) {
  const card = el('div', 'session-card');
  const top = el('div', 'sc-top');
  top.appendChild(statusDot(s.status));
  top.appendChild(el('div', 'sc-title', esc(s.title || shortPath(s.cwd) + ' · 新会话')));
  card.appendChild(top);
  const meta = el('div', 'sc-meta');
  meta.appendChild(el('span', 'chip chip-yellow', esc(s.settings || '')));
  if (s.model) meta.appendChild(el('span', 'chip chip-cyan', esc(s.model)));
  meta.appendChild(el('span', 'chip chip-plain', esc(shortPath(s.cwd))));
  meta.appendChild(el('span', 'chip', esc(STATUS_LABEL[s.status] || s.status)));
  card.appendChild(meta);
  const actions = el('div', 'sc-actions');
  const open = el('button', 'btn btn-sm btn-cyan', '打开 ➤');
  open.onclick = () => openActive(s.id);
  const exit = el('button', 'btn btn-sm', '退出');
  exit.onclick = () => { if (confirm('退出该会话？进程将被终止，历史仍可查看。')) sendWS({ t: 'exit', id: s.id }); };
  actions.appendChild(open); actions.appendChild(exit);
  card.appendChild(actions);
  return card;
}
function historyCard(h) {
  const card = el('div', 'session-card');
  card.appendChild(el('div', 'sc-top', `<div class="sc-title">${esc(h.title || h.snippet)}</div>`));
  if (h.snippet) card.appendChild(el('div', 'sc-snippet', esc(h.snippet)));
  const meta = el('div', 'sc-meta');
  if (h.model) meta.appendChild(el('span', 'chip chip-cyan', esc(h.model)));
  meta.appendChild(el('span', 'chip chip-plain', esc(shortPath(h.cwd))));
  meta.appendChild(el('span', 'chip', esc(fmtRel(h.mtime))));
  if (h.size > 1024 * 1024) meta.appendChild(el('span', 'chip', (h.size / 1048576).toFixed(1) + ' MB'));
  card.appendChild(meta);
  const actions = el('div', 'sc-actions');
  const resume = el('button', 'btn btn-sm btn-lime', '▶ 继续');
  resume.onclick = () => resumeSession(h.id);
  const view = el('button', 'btn btn-sm', '查看');
  view.onclick = () => openReadOnly(h.id);
  actions.appendChild(resume); actions.appendChild(view);
  card.appendChild(actions);
  return card;
}

// ---------------- chat lifecycle ----------------
function enterChatView() {
  document.body.classList.add('chatting');
  updateChatHeader();
}
function goHome() {
  if (current && !current.readOnly) sendWS({ t: 'detach', id: current.id });
  current = null; S = null;
  document.body.classList.remove('chatting');
  refreshSessions();
}
function openActive(id) {
  current = { id, info: sessionsData.active.find(a => a.id === id), readOnly: false };
  enterChatView();
  resetChat();
  showLoading('正在加载会话…', '读取历史并连接实时流');
  loadHistoryThenAttach(id);
}
function resumeSession(id, settings, force) {
  current = { id, info: null, readOnly: false };
  enterChatView();
  resetChat();
  showLoading('正在恢复会话…', '启动 claude 进程并加载历史');
  sendWS({ t: 'resume', id, settings, force });
}
function openReadOnly(id) {
  current = { id, info: null, readOnly: true };
  enterChatView();
  resetChat();
  switchToReadOnly(id);
}
async function switchToReadOnly(id) {
  current.readOnly = true;
  resetChat();
  showLoading('正在加载历史会话…', '解析会话记录文件');
  await nextFrame();
  try {
    const r = await fetch('/api/sessions/' + id + '/messages');
    if (!r.ok) throw new Error('会话不存在');
    const data = await r.json();
    current.meta = data;
    hideLoading();
    for (const ev of data.events) renderEvent(ev);
    const banner = appendBanner('readonly', '历史会话 · 只读视图');
    const btn = el('button', 'btn btn-sm btn-lime', '▶ Resume 继续此会话');
    btn.onclick = () => resumeSession(id);
    banner.appendChild(btn);
    updateChatHeader();
    afterRender(true);
  } catch (e) { hideLoading(); toast(e.message); goHome(); }
}
async function loadHistoryThenAttach(id) {
  // Render persisted history first (uuid-deduped), then replay live buffer.
  await nextFrame();
  try {
    const r = await fetch('/api/sessions/' + id + '/messages');
    if (r.ok) {
      const data = await r.json();
      current.meta = data;
      if (data.title && current.info && !current.info.title) current.info.title = data.title;
      for (const ev of data.events) renderEvent(ev);
    }
  } catch {}
  hideLoading();
  sendWS({ t: 'attach', id });
  updateChatHeader();
  afterRender(true);
}
function resetChat() {
  $('#msg-container').innerHTML = '';
  S = {
    uuids: new Set(), seenSeq: new Set(), msgs: new Map(), tools: new Map(), perms: new Map(),
    blockNodes: new Map(), dirty: new Set(), raf: 0,
    nearBottom: true, typing: null, titleSet: false, pendingUsers: [],
  };
  $('#jump-bottom').classList.remove('show');
  updateComposerState();
}
function showLoading(text, sub) {
  hideLoading();
  const box = el('div', 'loading-wrap');
  box.id = 'loading-box';
  const card = el('div', 'loading-card');
  card.appendChild(el('span', 'spinner spinner-lg'));
  const txt = el('div');
  txt.appendChild(el('div', 'loading-text', esc(text)));
  if (sub) txt.appendChild(el('div', 'loading-sub', esc(sub)));
  card.appendChild(txt);
  box.appendChild(card);
  const sk = el('div', 'skeleton');
  for (let i = 0; i < 3; i++) {
    const row = el('div', 'sk-msg');
    row.appendChild(el('div', 'sk-avatar'));
    const body = el('div', 'sk-body');
    body.appendChild(el('div', 'sk-line w40'));
    body.appendChild(el('div', 'sk-line w90'));
    body.appendChild(el('div', 'sk-line w70'));
    row.appendChild(body);
    sk.appendChild(row);
  }
  box.appendChild(sk);
  $('#msg-container').appendChild(box);
  scrollBottom(true);
}
function hideLoading() {
  const n = document.getElementById('loading-box');
  if (n) n.remove();
}
// let the loading state paint before heavy fetch/parse/render work begins
function nextFrame() {
  return new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
}
function appendBanner(kind, text) {
  const b = el('div', 'exit-banner');
  b.appendChild(el('span', '', esc(text)));
  $('#msg-container').appendChild(b);
  return b;
}

// ---------------- chat header / composer ----------------
function updateChatHeader() {
  if (!current) return;
  const info = current.info || {};
  const meta = current.meta || {};
  const title = info.title || meta.title || (current.readOnly ? '历史会话' : '新会话');
  $('#chat-title').textContent = title;
  $('#chat-title').title = title;
  const badges = $('#chat-badges');
  badges.innerHTML = '';
  const status = current.readOnly ? 'exited' : (info.status || 'starting');
  const st = el('span', 'chip chip-plain');
  st.style.display = 'inline-flex'; st.style.alignItems = 'center'; st.style.gap = '5px';
  st.appendChild(statusDot(status));
  st.appendChild(document.createTextNode(current.readOnly ? '只读' : (STATUS_LABEL[status] || status)));
  badges.appendChild(st);
  const model = info.model || meta.model;
  if (model) badges.appendChild(el('span', 'chip chip-cyan', esc(model)));
  if (info.settings) badges.appendChild(el('span', 'chip chip-yellow', esc(info.settings)));
  if (info.mode) {
    const modeChip = el('button', 'chip chip-lavender chip-mode', esc(MODE_LABEL[info.mode] || info.mode) + ' ▾');
    modeChip.title = '切换权限模式（相当于 CLI 的 Shift+Tab）';
    if (!current.readOnly && status !== 'exited' && status !== 'error') modeChip.onclick = e => { e.stopPropagation(); openModeMenu(modeChip); };
    else modeChip.disabled = true;
    badges.appendChild(modeChip);
  }
  const cwd = info.cwd || meta.cwd;
  if (cwd) badges.appendChild(el('span', 'chip chip-plain', esc(shortPath(cwd))));
  $('#btn-stop').style.display = (!current.readOnly && (status === 'running' || status === 'waiting_permission')) ? '' : 'none';
  const ended = status === 'exited' || status === 'error';
  $('#btn-exit').textContent = (current.readOnly || ended) ? '▶ Resume' : '退出会话';
  updateComposerState();
}
function updateComposerState() {
  const disabled = !current || current.readOnly || (current.info && (current.info.status === 'exited' || current.info.status === 'error'));
  $('#composer').classList.toggle('disabled', !!disabled);
  $('#input').disabled = !!disabled;
  $('#btn-send').disabled = !!disabled;
  $('#input').placeholder = disabled
    ? (current && current.readOnly ? '只读视图 — 点击 Resume 继续对话' : '会话已结束 — 点击 Resume 重新开始')
    : '给 Claude 发消息…';
  const status = current && current.info ? current.info.status : '';
  $('#composer-status').textContent = current && !current.readOnly ? (STATUS_LABEL[status] || '') : '';
}

// ---------------- message rendering ----------------
function scrollBottom(force) {
  const box = $('#messages');
  if (force || S.nearBottom) box.scrollTop = box.scrollHeight;
}
function afterRender(force) {
  if (!S) return;
  scrollBottom(force);
}
function msgRow(kind, ts) {
  const row = el('div', 'msg msg-' + kind);
  row.appendChild(el('div', 'msg-avatar', kind === 'user' ? 'U' : 'C'));
  const body = el('div', 'msg-body');
  const head = el('div', 'msg-head');
  head.appendChild(el('span', 'msg-name', kind === 'user' ? 'You' : 'Claude'));
  head.appendChild(el('span', 'msg-time', esc(fmtClock(ts))));
  body.appendChild(head);
  const content = el('div', 'msg-content');
  body.appendChild(content);
  row.appendChild(body);
  $('#msg-container').appendChild(row);
  return { row, content };
}
function setChatTitleFromText(text) {
  if (!S || S.titleSet || !text) return;
  S.titleSet = true;
  const t = text.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (current && current.info && !current.info.title) current.info.title = t;
  if (current && !current.meta) current.meta = { title: t };
  $('#chat-title').textContent = (current && current.info && current.info.title) || t;
}

function renderEvent(ev) {
  if (!S) return;
  // stored events carry a seq; replays (reconnect / re-attach) must not duplicate
  if (ev.seq != null) {
    if (S.seenSeq.has(ev.seq)) return;
    S.seenSeq.add(ev.seq);
  }
  switch (ev.k) {
    case 'user': return renderUser(ev);
    case 'assistant': return renderAssistant(ev);
    case 'stream': return renderStream(ev.event);
    case 'result': return renderResult(ev);
    case 'permission': return renderPermission(ev);
    case 'permission_resolved': return resolvePermission(ev);
    case 'init':
      if (current && current.info) {
        current.info.model = ev.model || current.info.model;
        current.info.mode = ev.permissionMode || current.info.mode;
        updateChatHeader();
      }
      break;
    case 'mode':
      if (current && current.info) { current.info.mode = ev.mode; updateChatHeader(); }
      break;
    case 'status':
      if (current && current.info && !current.readOnly) {
        if (ev.status === 'requesting') current.info.status = 'running';
        updateChatHeader();
        if (ev.status === 'requesting') showTyping();
      }
      break;
    case 'exit': {
      if (current && current.info) current.info.status = 'exited';
      removeTyping();
      const b = appendBanner('exit', '会话已退出' + (ev.code ? '（code ' + ev.code + '）' : '') + '，历史记录已保存。');
      const btn = el('button', 'btn btn-sm btn-lime', '▶ Resume');
      btn.onclick = () => resumeSession(current.id);
      b.appendChild(btn);
      updateChatHeader();
      break;
    }
    case 'error':
      removeTyping();
      appendBanner('error', '⚠ ' + ev.message);
      break;
    case 'system':
      if (ev.subtype === 'compact_boundary') $('#msg-container').appendChild(el('div', 'system-row', '上下文已自动压缩'));
      break;
  }
}

function renderUser(ev) {
  let content = ev.content;
  if (Array.isArray(content)) {
    const texts = [];
    for (const b of content) {
      if (b.type === 'tool_result') attachToolResult(b);
      else if (b.type === 'text' && b.text) texts.push(b.text);
    }
    content = texts.join('\n');
  }
  if (typeof content !== 'string' || !content.trim()) return;
  if (/^<(command-|local-command)/.test(content.trim()) || /^Caveat:/.test(content.trim())) return;
  // echo of a message we already rendered optimistically at send time:
  // adopt it (record uuid for replay dedupe) instead of drawing a second row
  const pi = S.pendingUsers.findIndex(p => p.text === content);
  if (pi >= 0) {
    S.pendingUsers.splice(pi, 1);
    if (ev.uuid) S.uuids.add(ev.uuid);
    return;
  }
  if (ev.uuid && S.uuids.has(ev.uuid)) return;
  if (ev.uuid) S.uuids.add(ev.uuid);
  removeTyping();
  const { content: node } = msgRow('user', ev.ts);
  node.textContent = content;
  setChatTitleFromText(content);
}

// ----- assistant message: merge streamed + final blocks -----
function getAssistantMsg(messageId, ts) {
  let m = S.msgs.get(messageId);
  if (!m) {
    const { row, content } = msgRow('assistant', ts);
    m = { row, content, blocks: [], nodes: [], nextIdx: 0, ts };
    S.msgs.set(messageId, m);
  }
  return m;
}
function renderAssistant(ev) {
  if (ev.uuid && S.uuids.has(ev.uuid)) return;
  if (ev.uuid) S.uuids.add(ev.uuid);
  removeTyping();
  const m = getAssistantMsg(ev.messageId, ev.ts);
  for (const b of ev.content || []) {
    if (b.type === 'tool_use') {
      const existing = m.blocks.findIndex(x => x && x.type === 'tool_use' && x.id === b.id);
      if (existing >= 0) { m.blocks[existing] = { ...b, final: true }; }
      else { m.blocks[m.nextIdx] = { ...b, final: true }; m.nextIdx++; }
    } else if (b.type === 'text' || b.type === 'thinking') {
      let idx = m.blocks.findIndex(x => x && x.type === b.type && !x.final);
      if (idx < 0) idx = m.nextIdx;
      const prev = m.blocks[idx];
      m.blocks[idx] = { ...b, final: true, text: b.type === 'text' ? (b.text || '') : (prev && prev.text || ''), thinking: b.type === 'thinking' ? (b.thinking || '') : (prev && prev.thinking || '') };
      m.nextIdx = Math.max(m.nextIdx, idx + 1);
    }
  }
  syncAssistantNodes(m);
}
function renderStream(event) {
  if (!event) return;
  const m0 = event.message;
  switch (event.type) {
    case 'message_start': {
      removeTyping();
      const m = getAssistantMsg(m0.id, new Date().toISOString());
      S.liveId = m0.id;
      break;
    }
    case 'content_block_start': {
      const m = S.msgs.get(S.liveId); if (!m) break;
      const cb = event.content_block || {};
      const i = event.index;
      if (m.blocks[i] && m.blocks[i].final) break;
      m.blocks[i] = { type: cb.type, id: cb.id, name: cb.name, text: '', thinking: '', partial: '', input: null };
      m.nextIdx = Math.max(m.nextIdx, i + 1);
      syncAssistantNodes(m);
      break;
    }
    case 'content_block_delta': {
      const m = S.msgs.get(S.liveId); if (!m) break;
      const b = m.blocks[event.index]; if (!b || b.final) break;
      const d = event.delta || {};
      if (d.type === 'text_delta') { b.text += d.text || ''; S.dirty.add(m); scheduleFlush(); }
      else if (d.type === 'thinking_delta') { b.thinking += d.thinking || ''; S.dirty.add(m); scheduleFlush(); }
      else if (d.type === 'input_json_delta') { b.partial += d.partial_json || ''; }
      break;
    }
    case 'message_stop':
      S.liveId = null;
      break;
  }
}
function scheduleFlush() {
  if (S.raf) return;
  S.raf = requestAnimationFrame(() => {
    S.raf = 0;
    if (!S) return;
    for (const m of S.dirty) syncAssistantNodes(m);
    S.dirty.clear();
    afterRender();
  });
}
function syncAssistantNodes(m) {
  for (let i = 0; i < m.blocks.length; i++) {
    const b = m.blocks[i];
    if (!b) continue;
    let node = m.nodes[i];
    if (!node || node._btype !== b.type) {
      node = createBlockNode(b);
      node._btype = b.type;
      m.nodes[i] = node;
    }
    updateBlockNode(node, b);
    if (node.parentNode !== m.content) m.content.appendChild(node);
    else if (m.content.children[i] !== node) m.content.insertBefore(node, m.content.children[i] || null);
  }
}
function createBlockNode(b) {
  if (b.type === 'text') return el('div', 'md');
  if (b.type === 'thinking') {
    const d = el('details', 'thinking');
    d.appendChild(el('summary', '', '思考过程'));
    d.appendChild(el('div', 'thinking-body'));
    return d;
  }
  if (b.type === 'tool_use') return buildToolCard(b);
  return el('div');
}
function updateBlockNode(node, b) {
  if (b.type === 'text') {
    if (node._text === b.text) return;
    node._text = b.text;
    const md = renderMarkdown(b.text);
    node.innerHTML = md.innerHTML;
    bindCodeCopy(node);
  } else if (b.type === 'thinking') {
    const body = node.querySelector('.thinking-body');
    if (body && body._t !== b.thinking) { body._t = b.thinking; body.textContent = b.thinking; }
    const sum = node.querySelector('summary');
    if (sum) sum.textContent = b.final ? '思考过程' : '思考中…';
  } else if (b.type === 'tool_use') {
    updateToolCard(node, b);
  }
}
function bindCodeCopy(root) {
  root.querySelectorAll('.codeblock-copy').forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.onclick = () => copyText(btn.closest('.codeblock').querySelector('code').textContent, btn);
  });
}

// ----- tool cards -----
function toolSummary(b) {
  const inp = b.input || {};
  switch (b.name) {
    case 'Bash': return inp.command || '';
    case 'Read': return inp.file_path || '';
    case 'Write': return inp.file_path || '';
    case 'Edit': return inp.file_path || '';
    case 'NotebookEdit': return inp.notebook_path || '';
    case 'Grep': return (inp.pattern || '') + (inp.path ? '  ·  ' + shortPath(inp.path) : '');
    case 'Glob': return inp.pattern || '';
    case 'Task': case 'Agent': return inp.description || (inp.prompt || '').slice(0, 80);
    case 'WebSearch': return inp.query || '';
    case 'WebFetch': return inp.url || '';
    case 'TodoWrite': return (inp.todos || []).map(t => t.content).join(' · ');
    case 'LSP': return (inp.operation || '') + ' ' + (inp.filePath || '');
    default: {
      const first = Object.values(inp)[0];
      return typeof first === 'string' ? first : JSON.stringify(inp).slice(0, 100);
    }
  }
}
function buildToolCard(b) {
  const card = el('div', 'toolcard is-running');
  const head = el('div', 'toolcard-head');
  const icon = el('span', 'toolcard-icon ' + (TOOL_COLOR[b.name] || 'chip-yellow'), esc(TOOL_ICON[b.name] || '⚙'));
  const name = el('span', 'toolcard-name', esc(b.name || 'tool'));
  const summary = el('span', 'toolcard-summary');
  const status = el('span', 'toolcard-status', '<span class="spinner"></span>');
  const chev = el('span', 'toolcard-chevron', '▸');
  head.append(icon, name, summary, status, chev);
  const body = el('div', 'toolcard-body');
  card.append(head, body);
  head.onclick = () => card.classList.toggle('open');
  card._refs = { summary, status, body, icon };
  if (b.id) S.tools.set(b.id, card);
  return card;
}
function updateToolCard(card, b) {
  const { summary, status, body } = card._refs;
  const sum = toolSummary(b);
  if (summary._s !== sum) { summary._s = sum; summary.textContent = sum; summary.title = sum; }
  let input = b.input;
  if (!input && b.partial) { try { input = JSON.parse(b.partial); } catch {} }
  const inputKey = input ? JSON.stringify(input) : (b.partial || '');
  if (body._ik !== inputKey) {
    body._ik = inputKey;
    body.innerHTML = '';
    body.appendChild(el('div', 'toolcard-label', '输入'));
    let pretty;
    try { pretty = JSON.stringify(input || JSON.parse(b.partial || '{}'), null, 2); } catch { pretty = b.partial || '{}'; }
    if (b.name === 'Bash' && input && input.command) pretty = input.command + (input.description ? '\n\n# ' + input.description : '');
    if ((b.name === 'Edit') && input && input.old_string !== undefined) {
      pretty = '- ' + input.old_string + '\n+ ' + (input.new_string || '');
    }
    body.appendChild(el('pre', '', esc(pretty)));
    if (card._result) appendResultToBody(body, card._result);
  }
  if (b.final && !card._result && !card.classList.contains('is-done')) {
    // tool_use finalized but result not yet arrived: keep spinner
  }
}
function appendResultToBody(body, result) {
  body.appendChild(el('div', 'toolcard-label', result.isError ? '输出（错误）' : '输出'));
  const pre = el('pre', '', esc(result.text || '(空)'));
  body.appendChild(pre);
}
function attachToolResult(b) {
  const card = S.tools.get(b.tool_use_id);
  if (!card) return;
  let text = b.content;
  if (Array.isArray(text)) text = text.map(x => x.type === 'text' ? x.text : '[' + x.type + ']').join('\n');
  if (text == null) text = '';
  const result = { text: String(text), isError: !!b.is_error };
  card._result = result;
  card.classList.remove('is-running');
  card.classList.add('is-done');
  if (result.isError) card.classList.add('is-error');
  card._refs.status.innerHTML = result.isError ? '✗' : '✓';
  const body = card._refs.body;
  body.querySelectorAll('.toolcard-label').forEach(l => { if (l.textContent.startsWith('输出')) { l.remove(); } });
  body.querySelectorAll('pre').forEach((p, i) => { if (i > 0) p.remove(); });
  appendResultToBody(body, result);
  const sum = card._refs.summary;
  if (result.isError && !sum._s) sum.textContent = '(error)';
}

// ----- result / permission / typing -----
function renderResult(ev) {
  removeTyping();
  const row = el('div', 'result-row' + (ev.isError ? ' is-error' : ''));
  const parts = [];
  parts.push(ev.isError ? '✗ 出错' : '✓ 完成');
  if (ev.durationMs != null) parts.push((ev.durationMs / 1000).toFixed(1) + 's');
  if (ev.costUsd != null) parts.push('$' + ev.costUsd.toFixed(4));
  if (ev.turns != null) parts.push(ev.turns + ' turns');
  if (ev.usage && ev.usage.output_tokens != null) parts.push('↑' + (ev.usage.input_tokens || 0) + ' ↓' + ev.usage.output_tokens + ' tokens');
  row.textContent = parts.join('  ·  ');
  if (ev.isError && ev.text) row.textContent += '  ·  ' + String(ev.text).slice(0, 200);
  $('#msg-container').appendChild(row);
  if (current && current.info && !current.readOnly) { current.info.status = 'idle'; updateChatHeader(); }
}
function renderPermission(ev) {
  removeTyping();
  const isPlan = ev.toolName === 'ExitPlanMode';
  const isEnterPlan = ev.toolName === 'EnterPlanMode';
  const card = el('div', 'permcard');
  card.appendChild(el('div', 'permcard-title', isPlan
    ? '📋 计划待批准 · 批准后开始执行'
    : isEnterPlan
      ? '📋 Claude 请求进入计划模式'
      : '🔐 权限请求 · <span style="font-family:var(--font-mono)">' + esc(ev.toolName) + '</span>'));
  if (isPlan) {
    const box = el('div', 'permcard-plan');
    box.appendChild(renderMarkdown((ev.input && ev.input.plan) || ''));
    card.appendChild(box);
  } else if (isEnterPlan) {
    card.appendChild(el('div', 'permcard-note', '批准后进入只读计划模式：Claude 只探索不修改，产出计划后再弹「计划待批准」卡片由你确认执行。'));
  } else {
    let pretty;
    try { pretty = JSON.stringify(ev.input, null, 2); } catch { pretty = String(ev.input); }
    if (ev.toolName === 'Bash' && ev.input && ev.input.command) pretty = ev.input.command;
    card.appendChild(el('pre', '', esc(pretty)));
  }
  const actions = el('div', 'permcard-actions');
  const allow = el('button', 'btn btn-sm btn-lime', isPlan ? '✓ 批准执行' : isEnterPlan ? '✓ 进入计划模式' : '✓ 允许');
  const deny = el('button', 'btn btn-sm btn-red', isPlan ? '✗ 拒绝计划' : isEnterPlan ? '✗ 保持当前模式' : '✗ 拒绝');
  allow.onclick = () => sendWS({ t: 'perm', id: current.id, requestId: ev.requestId, allow: true });
  deny.onclick = () => sendWS({ t: 'perm', id: current.id, requestId: ev.requestId, allow: false });
  actions.append(allow, deny);
  card.appendChild(actions);
  card.appendChild(el('div', 'permcard-result'));
  $('#msg-container').appendChild(card);
  S.perms.set(ev.requestId, card);
  if (current && current.info) { current.info.status = 'waiting_permission'; updateChatHeader(); }
}
function resolvePermission(ev) {
  const card = S.perms.get(ev.requestId);
  if (!card) return;
  card.classList.add('resolved');
  const label = { allow: '✓ 已允许', deny: '✗ 已拒绝', expired: '⌀ 已失效（会话结束）' }[ev.behavior] || ev.behavior;
  card.querySelector('.permcard-result').textContent = label;
}
function showTyping() {
  if (!S || S.typing) return;
  const row = el('div', 'typing-row');
  row.appendChild(el('div', 'msg-avatar', 'C'));
  row.appendChild(el('div', 'typing-bubble', '<i></i><i></i><i></i>'));
  $('#msg-container').appendChild(row);
  S.typing = row;
  afterRender();
}
function removeTyping() {
  if (S && S.typing) { S.typing.remove(); S.typing = null; }
}

// ---------------- composer ----------------
const input = $('#input');
function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(160, input.scrollHeight) + 'px';
}
input.addEventListener('input', autoGrow);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    doSend();
  }
});
$('#btn-send').onclick = doSend;
function doSend() {
  const text = input.value.trim();
  if (!text) return;
  if (!current || current.readOnly) { toast('请先 Resume 会话'); return; }
  if (current.info && (current.info.status === 'exited' || current.info.status === 'error')) { toast('会话已结束，请点击 Resume'); return; }
  if (!sendWS({ t: 'send', id: current.id, text })) return;
  input.value = '';
  autoGrow();
  // optimistic user row: visible immediately, echo adopts it later
  const { content: node } = msgRow('user', new Date().toISOString());
  node.textContent = text;
  S.pendingUsers.push({ text });
  setChatTitleFromText(text);
  if (current.info) current.info.status = 'running';
  updateChatHeader();
  showTyping();
  S.nearBottom = true;
  scrollBottom(true);
  input.focus();
}

// ---------------- scroll tracking ----------------
$('#messages').addEventListener('scroll', () => {
  if (!S) return;
  const box = $('#messages');
  S.nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  $('#jump-bottom').classList.toggle('show', !S.nearBottom);
});
$('#jump-bottom').onclick = () => { S.nearBottom = true; scrollBottom(true); $('#jump-bottom').classList.remove('show'); };
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => { if (S && S.nearBottom) scrollBottom(true); });
}

// ---------------- header / nav ----------------
$('#logo-home').onclick = goHome;
$('#btn-back').onclick = goHome;
$('#btn-stop').onclick = () => { if (current) sendWS({ t: 'interrupt', id: current.id }); };
$('#btn-exit').onclick = () => {
  if (!current) return;
  const st = current.info && current.info.status;
  if (current.readOnly || st === 'exited' || st === 'error') { resumeSession(current.id); return; }
  if (confirm('退出会话？claude 进程将被终止，历史记录保留，可随时 Resume。')) sendWS({ t: 'exit', id: current.id });
};

// ---------------- new session modal ----------------
const MODE_DESC = {
  bypassPermissions: '所有工具调用直接执行，适合可信的本机环境。',
  acceptEdits: '文件编辑自动通过；Bash 等其它工具会弹出授权卡片。',
  manual: '每个工具调用都会弹出授权卡片，由你允许或拒绝。',
  plan: '只读规划模式：Claude 先探索代码并产出计划，弹出计划卡片，批准后才开始执行。',
};
async function openNewModal() {
  const [settings, dirs] = await Promise.all([loadSettings(), loadDirs()]);
  const list = $('#settings-list');
  list.innerHTML = '';
  const saved = localStorage.getItem('myclaude.settings');
  let selected = settings.find(s => s.file === saved) || settings.find(s => s.isDefault) || settings[0];
  settings.forEach(s => {
    const opt = el('label', 'settings-opt' + (s === selected ? ' selected' : ''));
    const radio = el('input');
    radio.type = 'radio'; radio.name = 'settings'; radio.value = s.file;
    radio.checked = s === selected;
    radio.onchange = () => {
      selected = s;
      list.querySelectorAll('.settings-opt').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
    };
    opt.appendChild(radio);
    opt.appendChild(el('span', 'so-name', esc(s.file)));
    opt.appendChild(el('span', 'so-model', esc(s.model || s.host || '')));
    list.appendChild(opt);
  });
  const dl = $('#dirs-list');
  dl.innerHTML = dirs.map(d => `<option value="${esc(d)}">`).join('');
  $('#cwd-input').value = localStorage.getItem('myclaude.cwd') || dirs[0] || '';
  const modeSel = $('#mode-select');
  modeSel.value = localStorage.getItem('myclaude.mode') || 'bypassPermissions';
  $('#mode-desc').textContent = MODE_DESC[modeSel.value] || '';
  modeSel.onchange = () => $('#mode-desc').textContent = MODE_DESC[modeSel.value] || '';
  $('#modal-overlay').classList.add('show');
}
function closeNewModal() { $('#modal-overlay').classList.remove('show'); }
$('#btn-new-header').onclick = openNewModal;
$('#btn-new-home').onclick = openNewModal;
$('#btn-cancel-new').onclick = closeNewModal;
$('#modal-overlay').onclick = e => { if (e.target === e.currentTarget) closeNewModal(); };
$('#btn-create').onclick = () => {
  const settings = document.querySelector('input[name="settings"]:checked');
  const cwd = $('#cwd-input').value.trim();
  const mode = $('#mode-select').value;
  if (!settings) { toast('请选择一个 settings 配置'); return; }
  if (!cwd) { toast('请填写工作目录'); return; }
  localStorage.setItem('myclaude.settings', settings.value);
  localStorage.setItem('myclaude.cwd', cwd);
  localStorage.setItem('myclaude.mode', mode);
  closeNewModal();
  resetChatPending();
  sendWS({ t: 'create', settings: settings.value, cwd, mode });
};
function resetChatPending() {
  current = { id: null, info: null, readOnly: false };
  enterChatView();
  resetChat();
  showLoading('正在创建会话…', '启动 claude 进程');
}

// ---------------- mode switch menu (Shift+Tab equivalent) ----------------
const modeMenu = el('div');
modeMenu.id = 'mode-menu';
document.body.appendChild(modeMenu);
function closeModeMenu() { modeMenu.style.display = 'none'; }
function openModeMenu(anchor) {
  if (!current || !current.info) return;
  const cur = current.info.mode;
  modeMenu.innerHTML = '';
  for (const m of ['manual', 'acceptEdits', 'plan']) {
    const b = el('button', 'mode-opt' + (m === cur ? ' selected' : ''), esc(MODE_LABEL[m]));
    b.onclick = () => {
      closeModeMenu();
      if (sendWS({ t: 'mode', id: current.id, mode: m })) {
        current.info.mode = m; // optimistic; server rolls back via mode event on CLI error
        updateChatHeader();
      }
    };
    modeMenu.appendChild(b);
  }
  const r = anchor.getBoundingClientRect();
  modeMenu.style.display = 'flex';
  modeMenu.style.left = Math.max(8, Math.min(window.innerWidth - 158, r.left)) + 'px';
  modeMenu.style.top = (r.bottom + 6) + 'px';
}
document.addEventListener('click', e => {
  if (!modeMenu.contains(e.target) && !e.target.closest('.chip-mode')) closeModeMenu();
});

// ---------------- boot ----------------
connect();
refreshSessions();
