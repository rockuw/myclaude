// Read Claude Code session history from ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

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
        dir, cwd, title: title || firstPrompt.slice(0, 60),
        snippet: firstPrompt.replace(/\s+/g, ' ').slice(0, 140),
        model, branch,
        mtime: st.mtimeMs, size,
      });
    }
  }
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
  if (!file) return null;
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
  const data = { id, title: title || firstPrompt, cwd, model, permMode, events };
  msgCache.set(id, { mtime: st.mtimeMs, size: st.size, data });
  if (msgCache.size > 30) msgCache.delete(msgCache.keys().next().value);
  return data;
}

module.exports = { listSessions, getMessages, findSessionFile, PROJECTS_DIR };
