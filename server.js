// myclaude — web UI for Claude Code (LAN accessible, PC + mobile)
const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const { Manager, listSettings } = require('./manager');
const history = require('./history');

const PORT = process.env.PORT || 7801;
const app = express();
const server = http.createServer(app);
const manager = new Manager();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/settings', (req, res) => res.json(listSettings()));

app.get('/api/info', (req, res) => res.json({ hostname: os.hostname() }));

app.get('/api/codex-profiles', (req, res) => res.json(require('./codex').listProfiles()));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/sessions', (req, res) => {
  const active = manager.activeInfos();
  const activeIds = new Set(active.map(s => s.id));
  const hist = history.listSessions().map(h => ({ ...h, active: activeIds.has(h.id) }));
  res.json({ active, history: hist });
});

app.get('/api/sessions/:id/messages', (req, res) => {
  const data = history.getMessages(req.params.id);
  if (data) return res.json(data);
  // Freshly created sessions have no transcript file yet (the CLI writes it
  // after the first turn): serve empty history, the live attach replay covers it.
  const s = manager.sessions.get(req.params.id);
  if (s) return res.json({ id: s.id, engine: s.engine || 'claude', title: s.title || '', cwd: s.cwd, model: s.model || '', permMode: s.permissionMode, events: [] });
  res.status(404).json({ error: 'session not found' });
});

app.get('/api/dirs', (req, res) => {
  const dirs = new Set([os.homedir()]);
  const freeman = path.join(os.homedir(), 'freeman');
  try {
    for (const d of fs.readdirSync(freeman)) {
      const full = path.join(freeman, d);
      try { if (fs.statSync(full).isDirectory()) dirs.add(full); } catch {}
    }
  } catch {}
  for (const h of history.listSessions(200)) if (h.cwd) dirs.add(h.cwd);
  res.json([...dirs].sort());
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  manager.addClient(ws);
  ws.send(JSON.stringify({ t: 'hello', active: manager.activeInfos() }));
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      switch (msg.t) {
        case 'create': {
          const s = manager.create({ settings: msg.settings, cwd: msg.cwd || os.homedir(), mode: msg.mode || 'bypassPermissions', engine: msg.engine });
          s.subscribers.add(ws);
          ws.send(JSON.stringify({ t: 'created', session: manager.info(s) }));
          break;
        }
        case 'resume': {
          const s = manager.resume({ id: msg.id, settings: msg.settings, mode: msg.mode, cwd: msg.cwd, force: msg.force });
          s.subscribers.add(ws);
          ws.send(JSON.stringify({ t: 'created', session: manager.info(s) }));
          break;
        }
        case 'attach': {
          const s = manager.attach(ws, msg.id);
          if (!s) ws.send(JSON.stringify({ t: 'detached', id: msg.id }));
          break;
        }
        case 'detach':
          manager.detach(ws, msg.id);
          break;
        case 'send':
          manager.send(msg.id, String(msg.text || ''));
          break;
        case 'interrupt':
          manager.interrupt(msg.id);
          break;
        case 'mode':
          manager.setMode(msg.id, msg.mode);
          break;
        case 'perm':
          manager.permission(msg.id, msg.requestId, !!msg.allow, msg.updatedInput);
          break;
        case 'exit':
          manager.exit(msg.id);
          break;
        default:
          break;
      }
    } catch (err) {
      ws.send(JSON.stringify({ t: 'error', id: msg.id, message: err.message }));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`myclaude listening on:`);
  console.log(`  http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  http://${ip}:${PORT}`);
});

process.on('SIGTERM', () => { for (const s of manager.sessions.values()) manager.exit(s.id); setTimeout(() => process.exit(0), 500); });
process.on('SIGINT', () => { for (const s of manager.sessions.values()) manager.exit(s.id); setTimeout(() => process.exit(0), 500); });
