// Read Claude Code session history from ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

function readHeadTail(file, headBytes = 24 * 1024, tailBytes = 48 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(headBytes, size));
    fs.readSync(fd, head, 0, head.length, 0);
    let tail = head;
    if (size > headBytes) {
      tail = Buffer.alloc(Math.min(tailBytes, size));
      fs.readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
    }
    return { head: head.toString('utf8'), tail: tail.toString('utf8'), size };
  } finally {
    fs.closeSync(fd);
  }
}

function linesOf(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial line at buffer edge */ }
  }
  return out;
}

function firstText(content) {
  const ok = t => t && !/^<(command-|local-command)/.test(t.trim()) && !/^Caveat:/.test(t.trim());
  if (typeof content === 'string') return ok(content) ? content : '';
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type === 'text' && ok(b.text)) return b.text;
    }
  }
  return '';
}

function isHumanPrompt(d) {
  if (d.type !== 'user' || d.isMeta || d.isSidechain) return false;
  const c = d.message && d.message.content;
  const ok = t => t && t.trim() && !/^<(command-|local-command)/.test(t.trim()) && !/^Caveat:/.test(t.trim());
  if (typeof c === 'string') return ok(c);
  if (Array.isArray(c)) return c.some(b => b.type === 'text' && ok(b.text));
  return false;
}

// ---- codex session sources ----
function codexRolloutIndex() {
  const map = new Map();
  const walk = (dir, depth) => {
    let es;
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(full, depth + 1); }
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        const m = e.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
        if (m && !map.has(m[1])) {
          try { map.set(m[1], { path: full, mtime: fs.statSync(full).mtimeMs, size: fs.statSync(full).size }); } catch {}
        }
      }
    }
  };
  walk(path.join(CODEX_HOME, 'sessions'), 0);
  return map;
}

function codexThreadNames() {
  const idx = new Map();
  try {
    for (const line of fs.readFileSync(path.join(CODEX_HOME, 'session_index.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const j = JSON.parse(line); if (j.id) idx.set(j.id, j); } catch {}
    }
  } catch {}
  return idx;
}

function codexList(limit = 40) {
  const idx = codexThreadNames();
  const rolls = codexRolloutIndex();
  const out = [];
  // exec threads never reach session_index.jsonl; the rollout scan is the source
  for (const [id, r] of rolls) {
    let cwd = '', model = '', firstPrompt = '';
    try {
      const fd = fs.openSync(r.path, 'r');
      const buf = Buffer.alloc(32768);
      const n = fs.readSync(fd, buf, 0, 32768, 0);
      fs.closeSync(fd);
      for (const d of linesOf(buf.slice(0, n).toString('utf8'))) {
        const p = d.payload || {};
        if (d.type === 'session_meta') { cwd = p.cwd || ''; model = p.model || ''; }
        // model lives in turn_context/world_state, not session_meta; first wins
        // (later resumes may have recorded a different model)
        if (!model) model = p.model || (p.thread_settings || {}).model || ((p.state || {}).model) || '';
        if (!firstPrompt && d.type === 'response_item' && p.type === 'message' && p.role === 'user') {
          const t = (p.content || []).map(c => c.text || '').join(' ').trim();
          if (t && !t.startsWith('<')) firstPrompt = t.replace(/\s+/g, ' ').slice(0, 60);
        }
        if (cwd && firstPrompt) break;
      }
    } catch {}
    const j = idx.get(id) || {};
    out.push({
      id, engine: 'codex', dir: 'codex', cwd,
      title: j.thread_name || firstPrompt, snippet: firstPrompt, model, branch: '',
      mtime: r.mtime, size: r.size,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

function getCodexMessages(id, file) {
  const events = [];
  let cwd = '', model = '', firstPrompt = '', lastUsage = null, turnN = 0, lastUuid = null;
  const names = codexThreadNames();
  const text = fs.readFileSync(file, 'utf8');
  const push = ev => { events.push(ev); if (ev.uuid && ev.k !== 'result') lastUuid = ev.uuid; };
  for (const d of linesOf(text)) {
    const p = d.payload || {};
    if (d.type === 'session_meta') { cwd = p.cwd || cwd; model = p.model || model; continue; }
    if (!model) model = p.model || (p.thread_settings || {}).model || ((p.state || {}).model) || '';
    if (d.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const t = (p.content || []).map(c => c.text || '').join('\n');
      if (!t.trim() || t.trim().startsWith('<')) continue;
      if (!firstPrompt) firstPrompt = t.replace(/\s+/g, ' ').slice(0, 60);
      push({ k: 'user', uuid: 'cxu' + (p.id || events.length), content: t, ts: d.timestamp });
    } else if (d.type === 'event_msg' && p.type === 'item_completed') {
      const it = p.item || {};
      if (it.type === 'agent_message') {
        push({ k: 'assistant', uuid: 'cx' + it.id, messageId: it.id, content: [{ type: 'text', text: it.text || '' }], ts: d.timestamp });
      } else if (it.type === 'reasoning') {
        push({ k: 'assistant', uuid: 'cx' + it.id, messageId: it.id, content: [{ type: 'thinking', thinking: it.text || '' }], ts: d.timestamp });
      } else if (it.type === 'command_execution') {
        push({ k: 'assistant', uuid: 'cx' + it.id, messageId: it.id, content: [{ type: 'tool_use', id: it.id, name: 'Bash', input: { command: it.command } }], ts: d.timestamp });
        push({ k: 'user', uuid: 'cxr' + it.id, content: [{ type: 'tool_result', tool_use_id: it.id, content: it.aggregated_output || '', is_error: it.exit_code != null && it.exit_code !== 0 }], ts: d.timestamp });
      } else if (it.type === 'file_change') {
        push({ k: 'assistant', uuid: 'cx' + it.id, messageId: it.id, content: [{ type: 'tool_use', id: it.id, name: 'Edit', input: { file_path: (it.changes || []).map(c => c.path || '').join(', ') } }], ts: d.timestamp });
        push({ k: 'user', uuid: 'cxr' + it.id, content: [{ type: 'tool_result', tool_use_id: it.id, content: JSON.stringify(it.changes || {}, null, 2), is_error: false }], ts: d.timestamp });
      }
    } else if (d.type === 'event_msg' && p.type === 'token_count') {
      lastUsage = ((p.info || {}).total_token_usage) || lastUsage;
    } else if (d.type === 'event_msg' && p.type === 'task_complete') {
      turnN++;
      events.push({
        k: 'result', uuid: 'cxres_' + turnN, afterUuid: lastUuid, subtype: 'success', isError: false,
        turns: 1, usage: lastUsage ? { input_tokens: lastUsage.input_tokens, output_tokens: lastUsage.output_tokens } : undefined,
        ts: d.timestamp,
      });
    }
  }
  return { id, engine: 'codex', title: (names.get(id) || {}).thread_name || firstPrompt, cwd, model, events };
}

function listSessions(limit = 80) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return out; }
  for (const dir of dirs) {
    const full = path.join(PROJECTS_DIR, dir);
    let files;
    try { files = fs.readdirSync(full).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(full, f);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.size === 0) continue;
      let head, tail, size;
      try { ({ head, tail, size } = readHeadTail(file)); } catch { continue; }
      const headEntries = linesOf(head);
      const tailEntries = linesOf(tail);
      let cwd = '', firstPrompt = '', title = '', model = '', branch = '';
      for (const d of headEntries) {
        if (!cwd && d.cwd) cwd = d.cwd;
        if (!branch && d.gitBranch) branch = d.gitBranch;
        if (!firstPrompt && isHumanPrompt(d)) firstPrompt = firstText(d.message.content);
        if (d.type === 'ai-title' && d.aiTitle) title = d.aiTitle;
        if (cwd && firstPrompt) break;
      }
      for (const d of tailEntries) {
        if (d.type === 'ai-title' && d.aiTitle) title = d.aiTitle;
        if (d.type === 'assistant' && d.message && d.message.model) model = d.message.model;
        if (!cwd && d.cwd) cwd = d.cwd;
      }
      if (!firstPrompt && !title) continue; // empty / aborted session
      out.push({
        id: f.replace(/\.jsonl$/, ''),
        engine: 'claude',
        dir, cwd, title: title || firstPrompt.slice(0, 60),
        snippet: firstPrompt.replace(/\s+/g, ' ').slice(0, 140),
        model, branch,
        mtime: st.mtimeMs, size,
      });
    }
  }
  for (const c of codexList()) out.push(c);
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

function findSessionFile(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return null; }
  for (const dir of dirs) {
    const file = path.join(PROJECTS_DIR, dir, id + '.jsonl');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// Parse a full session file into the same event shape the live manager emits.
// Cached by mtime+size: resume parses once server-side and the client's
// follow-up /messages fetch hits the cache instead of re-parsing megabytes.
const msgCache = new Map();
function getMessages(id) {
  const file = findSessionFile(id);
  if (!file) {
    const r = codexRolloutIndex().get(id);
    if (!r) return null;
    const hit = msgCache.get(id);
    if (hit && hit.mtime === r.mtime && hit.size === r.size) return hit.data;
    const data = getCodexMessages(id, r.path);
    msgCache.set(id, { mtime: r.mtime, size: r.size, data });
    if (msgCache.size > 30) msgCache.delete(msgCache.keys().next().value);
    return data;
  }
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = msgCache.get(id);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.data;
  const events = [];
  let title = '', cwd = '', model = '', permMode = '', firstPrompt = '';
  const text = fs.readFileSync(file, 'utf8');
  for (const d of linesOf(text)) {
    if (d.cwd && !cwd) cwd = d.cwd;
    if (d.type === 'ai-title' && d.aiTitle) title = d.aiTitle;
    if (d.type === 'permission-mode' && d.permissionMode) permMode = d.permissionMode;
    if (!firstPrompt && isHumanPrompt(d)) firstPrompt = firstText(d.message.content).replace(/\s+/g, ' ').slice(0, 60);
    if (d.isSidechain) continue;
    const ts = d.timestamp || null;
    if (d.type === 'user' && !d.isMeta && d.message) {
      events.push({ k: 'user', uuid: d.uuid, content: d.message.content, ts });
    } else if (d.type === 'assistant' && d.message) {
      if (d.message.model) model = d.message.model;
      events.push({ k: 'assistant', uuid: d.uuid, messageId: d.message.id, content: d.message.content || [], model: d.message.model, ts });
    } else if (d.type === 'system' && d.subtype === 'compact_boundary') {
      events.push({ k: 'system', subtype: 'compact_boundary', ts });
    }
  }
  const data = { id, engine: 'claude', title: title || firstPrompt, cwd, model, permMode, events };
  msgCache.set(id, { mtime: st.mtimeMs, size: st.size, data });
  if (msgCache.size > 30) msgCache.delete(msgCache.keys().next().value);
  return data;
}

module.exports = { listSessions, getMessages, findSessionFile, PROJECTS_DIR };
