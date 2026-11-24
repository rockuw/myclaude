// Codex engine: per-turn `codex exec --json` spawns (resume via `exec resume`),
// translated into the same internal event shape the claude engine emits so the
// frontend stays unchanged.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SETTINGS_DIR = path.join(os.homedir(), '.claude');
const ENV_MAP_FILE = path.join(__dirname, 'data', 'codex-env.json');

function parseTomlLite(text) {
  const out = { tables: {} };
  let cur = out;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const tbl = line.match(/^\[([^\]]+)\]$/);
    if (tbl) {
      cur = out.tables[tbl[1]] = {};
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (kv) {
      let v = kv[2].trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      cur[kv[1]] = v;
    }
  }
  return out;
}

function providerInfo(cfg, providerId) {
  const t = cfg.tables['model_providers.' + providerId] || {};
  return { host: t.base_url || '', envKey: t.env_key || '', wireApi: t.wire_api || 'responses', id: providerId };
}

function listProfiles() {
  const out = [];
  let base = {};
  try { base = parseTomlLite(fs.readFileSync(path.join(CODEX_HOME, 'config.toml'), 'utf8')); } catch {}
  const baseProv = providerInfo(base, base.model_provider || '');
  out.push({ file: 'default', name: 'default', model: base.model || '', host: baseProv.host, envKey: baseProv.envKey, provId: baseProv.id, wireApi: baseProv.wireApi, isDefault: true });
  let files = [];
  try { files = fs.readdirSync(CODEX_HOME).filter(f => f.endsWith('.config.toml')); } catch {}
  for (const f of files) {
    let cfg = {};
    try { cfg = parseTomlLite(fs.readFileSync(path.join(CODEX_HOME, f), 'utf8')); } catch { continue; }
    const prov = providerInfo(cfg, cfg.model_provider || base.model_provider || '');
    out.push({
      file: f, name: f.replace(/\.config\.toml$/, ''),
      model: cfg.model || base.model || '', host: prov.host || baseProv.host,
      envKey: prov.envKey || baseProv.envKey,
      provId: prov.id || baseProv.id, wireApi: prov.wireApi || baseProv.wireApi,
      isDefault: false,
    });
  }
  return out;
}

// Resolve a profile's env_key: process env first, then the gitignored
// data/codex-env.json reference map ({settings, env} into claude settings).
function envForProfile(profile) {
  const key = profile && profile.envKey;
  if (!key || process.env[key]) return {};
  let map = {};
  try { map = JSON.parse(fs.readFileSync(ENV_MAP_FILE, 'utf8')); } catch {}
  const ref = map[key];
  if (!ref) return {};
  try {
    const s = JSON.parse(fs.readFileSync(path.join(SETTINGS_DIR, ref.settings), 'utf8'));
    const val = (s.env || {})[ref.env];
    if (val) return { [key]: val };
  } catch {}
  return {};
}

function modeArgs(mode) {
  switch (mode) {
    case 'bypassPermissions': return ['--dangerously-bypass-approvals-and-sandbox'];
    case 'plan': return ['-s', 'read-only', '-c', 'approval_policy="never"'];
    case 'manual': return ['-s', 'workspace-write', '-c', 'approval_policy="on-request"'];
    case 'acceptEdits':
    default: return ['-s', 'workspace-write', '-c', 'approval_policy="never"'];
  }
}

// `exec resume` accepts neither -C/-s/-p: profile & sandbox must go through
// -c overrides, which also beat the model/provider recorded in the thread.
function resumeOverrides(profile, mode) {
  const args = [];
  if (profile && profile.provId) {
    args.push('-c', `model="${profile.model}"`);
    args.push('-c', `model_provider="${profile.provId}"`);
    args.push('-c', `model_providers.${profile.provId}.name="${profile.name || profile.provId}"`);
    args.push('-c', `model_providers.${profile.provId}.base_url="${profile.host}"`);
    args.push('-c', `model_providers.${profile.provId}.wire_api="${profile.wireApi || 'responses'}"`);
    if (profile.envKey) args.push('-c', `model_providers.${profile.provId}.env_key="${profile.envKey}"`);
  }
  if (mode === 'bypassPermissions') args.push('--dangerously-bypass-approvals-and-sandbox');
  else {
    args.push('-c', `sandbox_mode="${mode === 'plan' ? 'read-only' : 'workspace-write'}"`);
    args.push('-c', `approval_policy="${mode === 'manual' ? 'on-request' : 'never'}"`);
  }
  return args;
}

function spawnTurn(s, text) {
  const profiles = listProfiles();
  const profile = profiles.find(p => p.file === s.settingsFile) || profiles[0];
  let args;
  if (s.codexThreadId) {
    args = ['exec', 'resume', '--json', '--skip-git-repo-check', ...resumeOverrides(profile, s.permissionMode), s.codexThreadId, text];
  } else {
    args = ['exec', '--json', '--skip-git-repo-check', '-C', s.cwd];
    if (profile && !profile.isDefault) args.push('-p', profile.name);
    args.push(...modeArgs(s.permissionMode), text);
  }
  const proc = spawn('codex', args, {
    cwd: s.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...envForProfile(profile) },
  });
  s.proc = proc;
  s.status = 'running';
  s.turnStartedAt = Date.now();
  s.gotTurnResult = false;
  return proc;
}

// Translate one codex exec JSONL event into internal events.
function translate(mgr, s, j) {
  const emitMsg = (k, uuid, extra) => {
    s.lastMsgUuid = uuid;
    mgr.emit(s, { k, uuid, ...extra });
  };
  switch (j.type) {
    case 'thread.started':
      s.codexThreadId = j.thread_id;
      if (mgr.meta[s.id]) { mgr.meta[s.id].codexThreadId = j.thread_id; mgr._saveMeta(); }
      mgr.emit(s, { k: 'init', uuid: 'cxinit_' + j.thread_id, model: s.model, permissionMode: s.permissionMode, engine: 'codex' });
      mgr.notifySessions();
      break;
    case 'turn.started':
      s.turnSeq = (s.turnSeq || 0) + 1;
      s.turnStartedAt = Date.now();
      s.gotTurnResult = false;
      mgr.emit(s, { k: 'status', status: 'requesting' }, { store: false });
      break;
    case 'item.started': {
      const it = j.item || {};
      if (it.type === 'command_execution') {
        emitMsg('assistant', 'cx' + it.id, { messageId: it.id, content: [{ type: 'tool_use', id: it.id, name: 'Bash', input: { command: it.command } }] });
      } else if (it.type === 'file_change') {
        emitMsg('assistant', 'cx' + it.id, { messageId: it.id, content: [{ type: 'tool_use', id: it.id, name: 'Edit', input: { file_path: (it.changes || []).map(c => c.path || c.file_path || '').join(', ') } }] });
      } else if (it.type === 'mcp_tool_call') {
        emitMsg('assistant', 'cx' + it.id, { messageId: it.id, content: [{ type: 'tool_use', id: it.id, name: it.tool || 'mcp', input: it.arguments || {} }] });
      }
      break;
    }
    case 'item.completed': {
      const it = j.item || {};
      if (it.type === 'agent_message') {
        emitMsg('assistant', 'cx' + it.id, { messageId: it.id, content: [{ type: 'text', text: it.text || '' }] });
      } else if (it.type === 'reasoning') {
        emitMsg('assistant', 'cx' + it.id, { messageId: it.id, content: [{ type: 'thinking', thinking: it.text || '' }] });
      } else if (it.type === 'command_execution') {
        emitMsg('user', 'cxr' + it.id, { content: [{ type: 'tool_result', tool_use_id: it.id, content: it.aggregated_output || '', is_error: it.exit_code != null && it.exit_code !== 0 }] });
      } else if (it.type === 'file_change') {
        emitMsg('user', 'cxr' + it.id, { content: [{ type: 'tool_result', tool_use_id: it.id, content: JSON.stringify(it.changes || {}, null, 2), is_error: false }] });
      } else if (it.type === 'mcp_tool_call') {
        emitMsg('user', 'cxr' + it.id, { content: [{ type: 'tool_result', tool_use_id: it.id, content: it.output || '', is_error: it.status === 'failed' }] });
      } else if (it.type === 'error') {
        if (!/Model metadata/.test(it.message || '')) mgr.emit(s, { k: 'error', message: it.message || 'codex item error' });
      }
      break;
    }
    case 'turn.completed': {
      s.gotTurnResult = true;
      s.status = 'idle';
      const u = j.usage || {};
      mgr.emit(s, {
        k: 'result', uuid: 'cxres_' + (s.turnSeq || 1), afterUuid: s.lastMsgUuid,
        subtype: 'success', isError: false, durationMs: Date.now() - (s.turnStartedAt || Date.now()),
        turns: 1, usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens },
      });
      mgr.notifySessions();
      break;
    }
    case 'error':
      mgr.emit(s, { k: 'error', message: j.message || 'codex error' });
      break;
    default:
      break;
  }
}

module.exports = { listProfiles, envForProfile, modeArgs, spawnTurn, translate, CODEX_HOME };
