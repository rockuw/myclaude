// Live session manager: one `claude` CLI child process per session,
// speaking the bidirectional stream-json protocol over stdin/stdout.
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
const history = require('./history');
const codex = require('./codex');

const SETTINGS_DIR = path.join(os.homedir(), '.claude');
const DATA_DIR = process.env.MYCLAUDE_DATA_DIR || path.join(__dirname, 'data');
const META_FILE = path.join(DATA_DIR, 'sessions.json');
const RESTART_FILE = path.join(DATA_DIR, 'restart.json');

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
      // stable seq lets clients dedupe replays after reconnect/attach
      ev.seq = s.seq = (s.seq || 0) + 1;
      s.events.push(ev);
      if (s.events.length > 8000) s.events.splice(0, s.events.length - 8000);
    }
    this.broadcast(s, ev);
  }

  info(s) {
    return {
      id: s.id, cwd: s.cwd, settings: s.settingsFile, mode: s.permissionMode,
      status: s.status, model: s.model, title: s.title, createdAt: s.createdAt,
      engine: s.engine || 'claude',
      codexThreadId: s.codexThreadId || null,
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

  create({ settings, cwd, mode, engine }) {
    const id = crypto.randomUUID();
    if (engine === 'codex') return this._createCodex({ id, settings, cwd, mode, resumed: false });
    return this._spawn({ id, settings, cwd, mode, resumed: false });
  }

  _createCodex({ id, settings, cwd, mode, resumed, title, threadId }) {
    const profiles = codex.listProfiles();
    const profile = profiles.find(p => p.file === settings) || profiles[0];
    if (!profile) throw new Error('没有可用的 codex profile');
    if (!fs.existsSync(cwd)) throw new Error('工作目录不存在: ' + cwd);
    const s = {
      id, engine: 'codex', proc: null, cwd, settingsFile: profile.file,
      permissionMode: mode || 'acceptEdits', status: 'idle', model: profile.model || '',
      title: title || '', resumed, createdAt: Date.now(), events: [],
      subscribers: new Set(), pending: new Map(), stderrTail: '',
      codexThreadId: threadId || (this.meta[id] && this.meta[id].codexThreadId) || null,
    };
    this.sessions.set(id, s);
    this.meta[id] = { settings: profile.file, mode: s.permissionMode, cwd, pid: null, title: s.title, engine: 'codex', codexThreadId: s.codexThreadId, updatedAt: Date.now() };
    this._saveMeta();
    this.notifySessions();
    return s;
  }

  resume({ id, settings, mode, cwd, force }) {
    const existing = this.sessions.get(id);
    if (existing && existing.status !== 'exited' && existing.status !== 'error') return existing;
    let hist = history.getMessages(id);
    // UI-created codex sessions use a myclaude uuid; the rollout is keyed by
    // codex thread id, so fall back to the thread id recorded in meta.
    if (!hist && this.meta[id] && this.meta[id].codexThreadId) hist = history.getMessages(this.meta[id].codexThreadId);
    if (!hist) throw new Error('找不到该历史会话: ' + id);
    if (hist.engine === 'codex') {
      const meta = this.meta[id] || {};
      const inferred = codex.listProfiles().find(p => p.model && hist.model && p.model === hist.model);
      const s = this._createCodex({
        id, settings: settings || meta.settings || (inferred && inferred.file) || 'default',
        cwd: cwd || meta.cwd || hist.cwd || os.homedir(),
        mode: mode || meta.mode || 'acceptEdits', resumed: true,
        title: hist.title || meta.title, threadId: meta.codexThreadId || id,
      });
      // keep live result uuids (cxres_<turnSeq>) from colliding with the
      // history rows already rendered for earlier turns
      s.turnSeq = hist.events.filter(e => e.k === 'result').length;
      return s;
    }
    // Safety: a transcript written seconds ago is likely live in another
    // terminal/process; resuming it would fork a running conversation.
    const oursExited = existing && (existing.status === 'exited' || existing.status === 'error');
    // a session that triggered ./restart.sh died with the old server by design;
    // let it resume without the freshness guard / force click
    let viaRestart = false;
    try {
      const marker = JSON.parse(fs.readFileSync(RESTART_FILE, 'utf8'));
      if (marker.id === id && Date.now() - marker.at < 120000) {
        viaRestart = true;
        fs.unlinkSync(RESTART_FILE);
      }
    } catch {}
    if (!force && !oursExited && !viaRestart) {
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
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli', MYCLAUDE_SESSION_ID: id },
    });
    const s = {
      id, proc, cwd, settingsFile: settings, permissionMode: mode,
      // CLIs in -p stream-json mode defer init until the first stdin message;
      // they accept input right away, so never show a blocking "starting" state
      status: 'idle', model: '', title: title || '', resumed,
      createdAt: Date.now(), events: [], subscribers: new Set(),
      pending: new Map(), stderrTail: '', gotResult: false,
    };
    this.sessions.set(id, s);
    // SDK-style handshake up front: the control channel must be ready before any turn
    this._write(s, { type: 'control_request', request_id: 'init_' + s.id, request: { subtype: 'initialize' } });
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
    if (s.engine === 'codex') { codex.translate(this, s, j); return; }
    switch (j.type) {
      case 'system':
        if (j.subtype === 'init') {
          // CLI re-emits init on permission-mode changes (set_permission_mode,
          // EnterPlanMode / ExitPlanMode approvals) — keep our badge in sync
          const cliMode = j.permissionMode || '';
          const mode = cliMode === 'default' ? 'manual' : (cliMode || s.permissionMode);
          const modeChanged = mode !== s.permissionMode;
          s.permissionMode = mode;
          s.model = j.model || s.model;
          s.status = 'idle';
          if (modeChanged && this.meta[s.id]) { this.meta[s.id].mode = mode; this._saveMeta(); }
          s.initInfo = { model: s.model, version: j.claude_code_version, permissionMode: mode, tools: (j.tools || []).length };
          this.emit(s, { k: 'init', ...s.initInfo, cwd: j.cwd });
          if (modeChanged) this.emit(s, { k: 'mode', mode });
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
          s.lastMsgUuid = j.uuid;
          this.emit(s, { k: 'assistant', uuid: j.uuid, messageId: j.message.id, content: j.message.content || [], model: j.message.model, ts: new Date().toISOString() });
        }
        break;
      case 'user':
        if (j.message) {
          s.lastMsgUuid = j.uuid;
          this.emit(s, { k: 'user', uuid: j.uuid, content: j.message.content, ts: new Date().toISOString() });
        }
        break;
      case 'result':
        s.status = 'idle';
        s.gotResult = true;
        this.emit(s, {
          k: 'result', subtype: j.subtype, isError: j.is_error, durationMs: j.duration_ms,
          costUsd: j.total_cost_usd, turns: j.num_turns, usage: j.usage, text: j.result,
          // anchor so replays insert the stats row after its turn, not at the end
          afterUuid: s.lastMsgUuid,
        });
        this.notifySessions();
        break;
      case 'control_request':
        this._handleControlRequest(s, j);
        break;
      case 'control_response':
        if (s.modeReq && j.response && j.response.request_id === s.modeReq.id) {
          if (j.response.subtype === 'error') {
            s.permissionMode = s.modeReq.prev; // roll back optimistic UI
            this.emit(s, { k: 'mode', mode: s.permissionMode });
            this.emit(s, { k: 'error', message: '模式切换失败: ' + (j.response.error || 'CLI 拒绝') });
            this.notifySessions();
          }
          s.modeReq = null;
        } else if (j.response && j.response.subtype === 'error') {
          this.emit(s, { k: 'error', message: '控制请求失败: ' + (j.response.error || JSON.stringify(j.response).slice(0, 120)) });
        }
        break; // acks for interrupt / set_permission_mode (mode arrives via init)
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
      this.emit(s, { k: 'permission', ...p, afterUuid: s.lastMsgUuid });
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
    if (!s.title) {
      s.title = text.replace(/\s+/g, ' ').trim().slice(0, 60);
      if (this.meta[s.id]) { this.meta[s.id].title = s.title; this._saveMeta(); }
    }
    if (s.engine === 'codex') {
      if (s.proc) throw new Error('codex 当前回合未完成，请稍候');
      const proc = codex.spawnTurn(s, text);
      let buf = '';
      proc.stdout.on('data', d => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (line.trim()) this._handleLine(s, line);
        }
      });
      proc.stderr.on('data', d => { s.stderrTail = (s.stderrTail + d.toString('utf8')).slice(-4000); });
      proc.on('exit', code => {
        s.proc = null;
        if (s.status === 'running' && !s.gotTurnResult) {
          s.status = 'idle';
          this.emit(s, { k: 'error', message: 'codex 回合异常结束（code ' + code + '）' + (s.stderrTail ? ': ' + s.stderrTail.slice(-300) : '') });
        } else if (s.status === 'running') {
          s.status = 'idle';
        }
        this.notifySessions();
      });
      this.notifySessions();
      return;
    }
    s.status = 'running';
    this._write(s, { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    this.notifySessions();
  }

  interrupt(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.engine === 'codex') {
      if (s.proc) { try { s.proc.kill('SIGTERM'); } catch {} }
      return;
    }
    this._write(s, { type: 'control_request', request_id: 'int_' + crypto.randomUUID(), request: { subtype: 'interrupt' } });
  }

  // Mid-session permission mode switch (CLI Shift+Tab equivalent).
  // bypassPermissions is only offered at creation time.
  setMode(id, mode) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('会话不存在');
    if (s.status === 'exited' || s.status === 'error') throw new Error('会话已结束');
    if (s.engine === 'codex') throw new Error('codex 会话的权限模式在创建时确定');
    if (!['manual', 'acceptEdits', 'plan'].includes(mode)) throw new Error('不支持的模式: ' + mode);
    const requestId = 'mode_' + crypto.randomUUID();
    s.modeReq = { id: requestId, prev: s.permissionMode };
    this._write(s, { type: 'control_request', request_id: requestId, request: { subtype: 'set_permission_mode', mode: mode === 'manual' ? 'default' : mode } });
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
    // mode transitions also arrive via re-emitted init; update eagerly for snappy UI
    if (allow && (p.toolName === 'EnterPlanMode' || p.toolName === 'ExitPlanMode')) {
      const m = p.toolName === 'EnterPlanMode' ? 'plan' : 'manual';
      if (s.permissionMode !== m) {
        s.permissionMode = m;
        if (this.meta[s.id]) { this.meta[s.id].mode = m; this._saveMeta(); }
        this.emit(s, { k: 'mode', mode: m });
      }
    }
    this.emit(s, { k: 'permission_resolved', requestId, behavior: allow ? 'allow' : 'deny' });
    if (s.pending.size === 0 && s.status === 'waiting_permission') s.status = 'running';
    this.notifySessions();
  }

  exit(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.status = 'exited';
    if (s.proc) {
      try { s.proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { if (s.proc && s.proc.exitCode === null) s.proc.kill('SIGKILL'); } catch {} }, 5000);
    }
    this.notifySessions();
  }
}

module.exports = { Manager, listSettings, matchSettings };
