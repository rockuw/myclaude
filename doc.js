// /doc — Markdown document viewer backed by public/doc/*.md
//   /doc/            list documents, newest first
//   /doc/<name>.md   rendered viewer (client-side marked + DOMPurify + hljs,
//                    the same pipeline the chat uses)
//   /doc/raw/<name>  raw markdown source
// Non-.md paths fall through to express.static so docs can ship side assets.
const fs = require('fs');
const path = require('path');
const express = require('express');

const DOC_DIR = path.join(__dirname, 'public', 'doc');

// Only plain basenames ending in .md; no traversal, no dotfiles.
function safeMdName(name) {
  if (typeof name !== 'string' || !name.endsWith('.md') || name.includes('\0')) return null;
  const base = path.basename(name);
  if (base !== name || base.startsWith('.')) return null;
  return base;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function listDocs() {
  let entries = [];
  try { entries = fs.readdirSync(DOC_DIR, { withFileTypes: true }); } catch {}
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('.')) continue;
    const full = path.join(DOC_DIR, e.name);
    try {
      const st = fs.statSync(full);
      let title = '';
      const fd = fs.openSync(full, 'r');
      try {
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        const m = buf.slice(0, n).toString('utf8').match(/^#\s+(.+)$/m);
        if (m) title = m[1].trim();
      } finally { fs.closeSync(fd); }
      out.push({ name: e.name, title, mtime: st.mtimeMs, size: st.size });
    } catch {}
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function relTime(ms) {
  const d = Date.now() - ms;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
  const t = new Date(ms);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/doc.css">
<link rel="stylesheet" href="/vendor/hljs.css">
</head>
<body>
${body}
</body>
</html>`;
}

const router = express.Router();

router.get('/', (req, res) => {
  const docs = listDocs();
  const items = docs.map(d => `
    <li class="doc-item">
      <a class="doc-title" href="/doc/${encodeURIComponent(d.name)}">${esc(d.title || d.name)}</a>
      <div class="doc-meta"><span class="doc-file">${esc(d.name)}</span><span>${relTime(d.mtime)}</span><span>${fmtSize(d.size)}</span></div>
    </li>`).join('');
  const body = `
<div class="doc-wrap">
  <header class="doc-head">
    <h1>📄 文档</h1>
    <a class="doc-back" href="/">← myclaude</a>
  </header>
  <p class="doc-sub">public/doc/ 下的 Markdown 文档，按修改时间排序</p>
  ${docs.length ? `<ul class="doc-list">${items}</ul>`
    : '<div class="doc-empty">还没有文档。把 .md 文件放入 <code>~/myclaude/public/doc/</code> 即可出现在这里。</div>'}
</div>`;
  res.type('html').send(page('文档 · myclaude', body));
});

router.get('/raw/:name', (req, res) => {
  const name = safeMdName(req.params.name);
  if (!name) return res.status(400).type('text').send('invalid document name');
  fs.readFile(path.join(DOC_DIR, name), 'utf8', (err, text) => {
    if (err) return res.status(404).type('text').send('document not found');
    res.type('text/plain; charset=utf-8').send(text);
  });
});

router.get('/:name', (req, res, next) => {
  const name = safeMdName(req.params.name);
  if (!name) return next(); // side assets (images etc.) served by express.static
  let st;
  try { st = fs.statSync(path.join(DOC_DIR, name)); } catch {
    return res.status(404).type('html').send(page('404 · myclaude', `
<div class="doc-wrap">
  <header class="doc-head"><h1>文档不存在</h1><a class="doc-back" href="/doc/">← 文档列表</a></header>
  <div class="doc-empty"><code>${esc(name)}</code> 不在 public/doc/ 中。</div>
</div>`));
  }
  const body = `
<div class="doc-wrap">
  <header class="doc-head doc-bar">
    <a class="doc-back" href="/doc/">← 文档列表</a>
    <span class="doc-meta-inline">${esc(name)} · ${relTime(st.mtimeMs)} · ${fmtSize(st.size)}</span>
    <a class="doc-back" href="/doc/raw/${encodeURIComponent(name)}" target="_blank" rel="noopener noreferrer">原始 Markdown</a>
  </header>
  <article id="content" class="md">加载中…</article>
</div>
<script src="/vendor/marked.min.js"></script>
<script src="/vendor/purify.min.js"></script>
<script src="/vendor/highlight.min.js"></script>
<script>
(function () {
  var name = ${JSON.stringify(name)};
  var box = document.getElementById('content');
  fetch('/doc/raw/' + encodeURIComponent(name)).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }).then(function (text) {
    marked.setOptions({ gfm: true, breaks: true });
    box.innerHTML = DOMPurify.sanitize(marked.parse(text), { ADD_ATTR: ['target'] });
    box.querySelectorAll('pre > code').forEach(function (c) { try { hljs.highlightElement(c); } catch (e) {} });
    box.querySelectorAll('a').forEach(function (a) { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
    var h1 = box.querySelector('h1');
    document.title = (h1 ? h1.textContent : name) + ' · myclaude 文档';
  }).catch(function (e) {
    box.textContent = '加载失败：' + e.message;
  });
})();
</script>`;
  res.type('html').send(page(name + ' · myclaude 文档', body));
});

module.exports = router;
