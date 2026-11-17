// Live session manager: one `claude` CLI child process per session,
// speaking the bidirectional stream-json protocol over stdin/stdout.
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
const history = require('./history');

const SETTINGS_DIR = path.join(os.homedir(), '.claude');
const META_FILE = path.join(__dirname, 'data', 'sessions.json');

function listSettings() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(SETTINGS_DIR).filter(f => /^settings(\..+)?\.json$/.test(f)); } catch {}
  for (const f of files) {
    let model = '', host = '', extra = {};
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SETTINGS_DIR, f), 'utf8'));
      const env = j.env || {};
      model = j.model || env.ANTHROPIC_MODEL || '';
      if (env.ANTHROPIC_BASE_URL) { try { host = new URL(env.ANTHROPIC_BASE_URL).host; } catch {} }
      if (env.ANTHROPIC_SMALL_FAST_MODEL) extra.smallModel = env.ANTHROPIC_SMALL_FAST_MODEL;
    } catch { continue; }
    out.push({ file: f, path: path.join(SETTINGS_DIR, f), name: f.replace(/^settings\.?/, '').replace(/\.json$/, '') || 'default', model, host, isDefault: f === 'settings.json' });
  }
  out.sort((a, b) => (b.isDefault - a.isDefault) || a.file.localeCompare(b.file));
  return out;
}

function matchSettings(model) {
  const all = listSettings();
  if (!model) return all.find(s => s.isDefault) || all[0];
  const norm = m => String(m).replace(/\[.*\]$/, '');
  const hits = all.filter(s => s.model && norm(s.model) === norm(model));
  return hits.find(s => s.isDefault) || hits[0] || all.find(s => s.isDefault) || all[0];
}

class Manager {
  constructor() {
    this.sessions = new Map(); // id -> session
    this.clients = new Set();  // all connected websockets
    this.meta = {};            // id -> {settings, mode, cwd, pid, title}
    try { this.meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch {}
    this._reapOrphans();
  }

  _saveMeta() {
    try {
      fs.mkdirSync(path.dirname(META_FILE), { recursive: true });
      fs.writeFileSync(META_FILE, JSON.stringify(this.meta, null, 2));
    } catch {}
  }

  // Kill claude children left over from a previous server run.
  _reapOrphans() {
    for (const [id, m] of Object.entries(this.meta)) {
      if (!m.pid) continue;
      try {
        const cmd = fs.readFileSync(`/proc/${m.pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
        if (cmd.includes('stream-json') && (cmd.includes('--resume ' + id) || cmd.includes('--session-id ' + id))) {
          process.kill(m.pid, 'SIGTERM');
        }
      } catch {}
    }
  }

  addClient(ws) {
    this.clients.add(ws);
    ws.on('close', () => {
      this.clients.delete(ws);
      for (const s of this.sessions.values()) s.subscribers.delete(ws);
    });
  }

  broadcastAll(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(data);
  }

  broadcast(s, msg) {
    const data = JSON.stringify({ t: 'event', id: s.id, ev: msg });
    for (const ws of s.subscribers) if (ws.readyState === 1) ws.send(data);
  }

  emit(s, ev, { store = true } = {}) {
    if (store) {
      s.events.push(ev);
      if (s.events.length > 8000) s.events.splice(0, s.events.length - 8000);
    }
    this.broadcast(s, ev);
  }

  info(s) {
    return {
      id: s.id, cwd: s.cwd, settings: s.settingsFile, mode: s.permissionMode,
      status: s.status, model: s.model, title: s.title, createdAt: s.createdAt,
      resumed: s.resumed, pendingPermissions: [...s.pending.values()].map(p => ({ requestId: p.requestId, toolName: p.toolName })),
    };
  }

  activeInfos() {
    return [...this.sessions.values()]
      .filter(s => s.status !== 'exited' && s.status !== 'error')
      .map(s => this.info(s));
  }

  notifySessions() {
    this.broadcastAll({ t: 'sessions', active: this.activeInfos() });
  }

  create({ settings, cwd, mode }) {
    const id = crypto.randomUUID();
    return this._spawn({ id, settings, cwd, mode, resumed: false });
  }

  resume({ id, settings, mode, cwd, force }) {
    const existing = this.sessions.get(id);
    if (existing && existing.status !== 'exited' && existing.status !== 'error') return existing;
    const hist = history.getMessages(id);
    if (!hist) throw new Error('找不到该历史会话: ' + id);
    // Safety: a transcript written seconds ago is likely live in another
    // terminal/process; resuming it would fork a running conversation.
    const oursExited = existing && (existing.status === 'exited' || existing.status === 'error');
    if (!force && !oursExited) {
      const file = history.findSessionFile(id);
      try {
        const age = Date.now() - fs.statSync(file).mtimeMs;
        if (age < 10000) throw new Error('该会话刚刚仍在写入，可能正在其它终端/进程中运行。确认无冲突后可强制恢复。');
      } catch (e) {
        if (/刚刚仍在写入/.test(e.message)) throw e;
      }
    }
    const meta = this.meta[id] || {};
    const settingsObj = settings
      ? listSettings().find(s => s.file === settings)
      : (meta.settings && listSettings().find(s => s.file === meta.settings)) || matchSettings(hist.model);
    if (!settingsObj) throw new Error('没有可用的 settings 配置');
    return this._spawn({
      id, settings: settingsObj.file, cwd: cwd || meta.cwd || hist.cwd || os.homedir(),
      mode: mode || meta.mode || hist.permMode || 'bypassPermissions', resumed: true, title: hist.title || meta.title,
    });
  }

  _spawn({ id, settings, cwd, mode, resumed, title }) {
    const settingsObj = listSettings().find(s => s.file === settings);
    if (!settingsObj) throw new Error('配置文件不存在: ' + settings);
    if (!fs.existsSync(cwd)) throw new Error('工作目录不存在: ' + cwd);
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--settings', settingsObj.path,
      '--setting-sources', 'project,local',
    ];
    if (mode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
    else args.push('--permission-mode', mode, '--permission-prompt-tool', 'stdio');
    if (resumed) args.push('--resume', id);
    else args.push('--session-id', id);

    const proc = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli' },
    });
    const s = {
      id, proc, cwd, settingsFile: settings, permissionMode: mode,
      // resumed CLIs defer init until the first stdin message; they accept input right away
      status: resumed ? 'idle' : 'starting', model: '', title: title || '', resumed,
      createdAt: Date.now(), events: [], subscribers: new Set(),
      pending: new Map(), stderrTail: '', gotResult: false,
    };
    this.sessions.set(id, s);
    this.meta[id] = { settings, mode, cwd, pid: proc.pid, title: s.title, updatedAt: Date.now() };
    this._saveMeta();

    let buf = '';
    proc.stdout.on('data', d => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) this._handleLine(s, line);
      }
    });
    proc.stderr.on('data', d => {
      s.stderrTail = (s.stderrTail + d.toString('utf8')).slice(-4000);
    });
    proc.on('error', err => {
      s.status = 'error';
      this.emit(s, { k: 'error', message: '启动 claude 失败: ' + err.message });
      this.notifySessions();
    });
    proc.on('exit', code => {
      if (s.status !== 'error') s.status = 'exited';
      s.exitCode = code;
      for (const p of s.pending.values()) this.emit(s, { k: 'permission_resolved', requestId: p.requestId, behavior: 'expired' });
      s.pending.clear();
      this.emit(s, { k: 'exit', code });
      this.notifySessions();
    });
    this.notifySessions();
    return s;
  }

  _handleLine(s, line) {
    let j;
    try { j = JSON.parse(line); } catch { return; }
    switch (j.type) {
      case 'system':
        if (j.subtype === 'init') {
          s.model = j.model || '';
          s.status = 'idle';
          s.initInfo = { model: j.model, version: j.claude_code_version, permissionMode: j.permissionMode, tools: (j.tools || []).length };
          this.emit(s, { k: 'init', ...s.initInfo, cwd: j.cwd });
          // SDK-style handshake so the CLI routes permission prompts to stdio
          this._write(s, { type: 'control_request', request_id: 'init_' + s.id, request: { subtype: 'initialize' } });
          this.notifySessions();
        } else if (j.subtype === 'status') {
          if (j.status === 'requesting') s.status = 'running';
          this.emit(s, { k: 'status', status: j.status }, { store: false });
        } else if (j.subtype === 'compact_boundary') {
          this.emit(s, { k: 'system', subtype: 'compact_boundary' });
        }
        break;
      case 'stream_event':
        this.emit(s, { k: 'stream', event: j.event }, { store: false });
        break;
      case 'assistant':
        if (j.message) {
          s.status = 'running';
          this.emit(s, { k: 'assistant', uuid: j.uuid, messageId: j.message.id, content: j.message.content || [], model: j.message.model, ts: new Date().toISOString() });
        }
        break;
      case 'user':
        if (j.message) this.emit(s, { k: 'user', uuid: j.uuid, content: j.message.content, ts: new Date().toISOString() });
        break;
      case 'result':
        s.status = 'idle';
        s.gotResult = true;
        this.emit(s, {
          k: 'result', subtype: j.subtype, isError: j.is_error, durationMs: j.duration_ms,
          costUsd: j.total_cost_usd, turns: j.num_turns, usage: j.usage, text: j.result,
        });
        this.notifySessions();
        break;
      case 'control_request':
        this._handleControlRequest(s, j);
        break;
      case 'control_response':
        break; // ack for our interrupt requests
      default:
        break;
    }
  }

  _handleControlRequest(s, j) {
    const req = j.request || {};
    if (req.subtype === 'can_use_tool') {
      const p = { requestId: j.request_id, toolName: req.tool_name, input: req.input, suggestions: req.permission_suggestions };
      s.pending.set(j.request_id, p);
      s.status = 'waiting_permission';
      this.emit(s, { k: 'permission', ...p });
      this.notifySessions();
    } else {
      // Unknown control request: answer success-empty so the CLI never stalls.
      this._write(s, { type: 'control_response', response: { subtype: 'success', request_id: j.request_id, response: {} } });
    }
  }

  _write(s, obj) {
    if (s.proc.stdin.writable) s.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  attach(ws, id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.subscribers.add(ws);
    ws.send(JSON.stringify({ t: 'attached', session: this.info(s), events: s.events }));
    return s;
  }

  detach(ws, id) {
    const s = this.sessions.get(id);
    if (s) s.subscribers.delete(ws);
  }

  send(id, text) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('会话不存在');
    if (s.status === 'exited' || s.status === 'error') throw new Error('会话已结束，请重新 resume');
    s.status = 'running';
    if (!s.title) {
      s.title = text.replace(/\s+/g, ' ').trim().slice(0, 60);
      if (this.meta[s.id]) { this.meta[s.id].title = s.title; this._saveMeta(); }
    }
    this._write(s, { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    this.notifySessions();
  }

  interrupt(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    this._write(s, { type: 'control_request', request_id: 'int_' + crypto.randomUUID(), request: { subtype: 'interrupt' } });
  }

  permission(id, requestId, allow, updatedInput) {
    const s = this.sessions.get(id);
    if (!s) return;
    const p = s.pending.get(requestId);
    if (!p) return;
    s.pending.delete(requestId);
    const response = allow
      ? { behavior: 'allow', updatedInput: updatedInput || p.input }
      : { behavior: 'deny', message: '用户拒绝了此操作' };
    this._write(s, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.emit(s, { k: 'permission_resolved', requestId, behavior: allow ? 'allow' : 'deny' });
    if (s.pending.size === 0 && s.status === 'waiting_permission') s.status = 'running';
    this.notifySessions();
  }

  exit(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.status = 'exited';
    try { s.proc.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { if (s.proc.exitCode === null) s.proc.kill('SIGKILL'); } catch {} }, 5000);
    this.notifySessions();
  }
}

module.exports = { Manager, listSettings, matchSettings };
