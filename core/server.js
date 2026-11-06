#!/usr/bin/env node
/* AIOS core — HTTP, module loader, command registry, events. Zero dependencies.
 * Modules live in modules/<id>/ (spec: projects/aios-v3/spec.md). Today's AIOS runs as
 * the `legacy` module until every part has moved out of it. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const machine = require('./machine.js');
const security = require('./security.js').create(machine.get);
const { createBus } = require('./events.js');
const { createRegistry } = require('./commands.js');
const { createLoader, CORE_VERSION } = require('./modules.js');
const { createInstaller } = require('./install.js');

const ROOT = machine.ROOT;
const SHELL = path.join(ROOT, 'shell');
const MODULE_DIRS = [path.join(ROOT, 'modules')]
  .concat(process.env.AIOS_EXTRA_MODULES ? [path.resolve(process.env.AIOS_EXTRA_MODULES)] : []);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};

const bus = createBus();
const commands = createRegistry();
const loader = createLoader({ dirs: MODULE_DIRS, root: ROOT, config: machine, bus, commands, vault: require('./vault.js').forRoot(ROOT) });
const installer = createInstaller({ modulesDir: path.join(ROOT, 'modules') });

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 1 << 20) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function sendFile(res, file, transform) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const out = transform ? Buffer.from(transform(data.toString('utf8'))) : data;
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(out);
  });
}
function inside(base, rel) {
  const f = path.resolve(base, rel);
  return f.startsWith(base + path.sep) ? f : null;
}
// The design export never carries logic (spec §8.1): core adds the shell script at serve time,
// and a <base> so the export's own relative links (theme.css, fonts/) resolve from shell/design/
// while the frame is served at /. Shell code uses absolute paths, so <base> does not affect it.
function shellHtml(html) {
  const tag = '<script type="module" src="/shell/app.js"></script>';
  const base = '<base href="/shell/design/">';
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + '\n' + base) : base + html;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tag + '\n</body>') : html + tag;
}

async function coreApi(req, res, p) {
  if (p === '/api/core/modules' && req.method === 'GET')
    return json(res, 200, { core: CORE_VERSION, machine: machine.get().machineName, modules: loader.list(), commands: commands.list(), vocabulary: commands.vocabulary() });
  if (req.method !== 'POST') return json(res, 404, { error: 'unknown endpoint ' + p });
  if (!security.isLoopback(req)) return json(res, 403, { error: 'local only' });
  const b = await readJson(req);
  if (p === '/api/core/match')
    return json(res, 200, { match: commands.match(String(b.text || '')) });
  if (p === '/api/core/run')
    return json(res, 200, await commands.run(String(b.text || ''), { source: String(b.source || 'palette'), confirmed: b.confirmed === true }));
  if (p === '/api/core/modules/toggle')
    return json(res, 200, await loader.setEnabled(String(b.id || ''), b.enabled === true));
  if (p === '/api/core/modules/inspect')
    return json(res, 200, await installer.inspect(String(b.url || '')));
  if (p === '/api/core/modules/install') {
    if (b.confirm !== true) return json(res, 400, { error: 'install needs confirm: true' });
    const r = installer.install(String(b.url || ''));
    machine.mergeModule(r.id, { enabled: false }); // installed OFF, whatever its manifest says
    loader.scan();
    bus.emit('core.modules', null);
    return json(res, 200, r);
  }
  if (p === '/api/core/modules/update') {
    const out = await installer.update(String(b.id || ''));
    await loader.reload(String(b.id));
    return json(res, 200, { ok: true, output: out });
  }
  return json(res, 404, { error: 'unknown endpoint ' + p });
}

async function handle(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  const deny = security.guard(req, p);
  if (deny) return json(res, deny.code, { error: deny.error });
  if (p === '/api/events' && req.method === 'GET') return bus.sse(req, res);
  if (p.startsWith('/api/core/')) return coreApi(req, res, p);
  if (p.startsWith('/api/m/')) {
    const r = loader.route(req.method, p);
    if (!r) return json(res, 404, { error: 'unknown endpoint ' + p });
    const body = req.method === 'POST' ? await readJson(req) : null;
    try { return await r.handler(req, res, body); }
    catch (e) { if (!res.headersSent) return json(res, 500, { error: r.module + ': ' + e.message }); return res.end(); }
  }
  if (req.method === 'GET' && (p === '/' || p === '/index.html'))
    return sendFile(res, path.join(SHELL, 'design', 'frame.html'), shellHtml);
  const modPage = req.method === 'GET' && loader.page(p);
  if (modPage) return sendFile(res, modPage);
  if (req.method === 'GET' && p.startsWith('/shell/')) {
    const f = inside(SHELL, decodeURIComponent(p.slice('/shell/'.length)));
    if (!f) { res.writeHead(403); return res.end(); }
    return sendFile(res, f);
  }
  const mm = /^\/m\/([a-z][a-z0-9-]{1,31})\/(.+)$/.exec(p);
  if (req.method === 'GET' && mm) {
    const f = loader.staticFile(mm[1], decodeURIComponent(mm[2]));
    if (!f) { res.writeHead(404); return res.end('not found'); }
    return sendFile(res, f);
  }
  const fb = loader.fallback();
  if (fb) return fb(req, res);
  if (p.startsWith('/api/')) return json(res, 404, { error: 'unknown endpoint ' + p });
  res.writeHead(404); res.end('not found');
}

async function main() {
  loader.scan();
  await loader.loadAll();
  const m = machine.get();
  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => {
      if (!res.headersSent) json(res, e.status || 500, { error: e.message });
      else res.end();
    });
  });
  server.on('error', e => {
    console.error(e.code === 'EADDRINUSE' ? 'Port ' + m.port + ' is busy — AIOS already running on :' + m.port + '?' : 'Server error: ' + e.message);
    process.exit(1);
  });
  // 127.0.0.1 only by default; "lanEnabled": true in system/machine.json opens the LAN
  server.listen(m.port, m.lanEnabled ? '0.0.0.0' : '127.0.0.1', () => {
    bus.emit('core.listening', { port: m.port });
    console.log('core:  v' + CORE_VERSION + '  ·  ' + loader.list().map(x => x.id + ':' + x.status).join('  '));
  });
  const shutdown = () => { loader.stopAll().then(() => process.exit(0), () => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();
module.exports = { main };
