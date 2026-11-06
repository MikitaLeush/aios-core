'use strict';
/* Module discovery + lifecycle (spec projects/aios-v3/spec.md §4). A module is a folder
 * with module.json. Everything is injected, so tests run without the real machine.json
 * or the real modules/ folder. Modules share this process: a module stuck in an endless
 * loop still hangs the server — out of scope (spec §4.3). */
const fs = require('fs');
const path = require('path');

const CORE_VERSION = 1;
const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

function createLoader(opts) {
  const log = opts.log || ((...a) => console.log(...a));
  const mods = new Map();   // id -> record
  const routes = new Map(); // "GET /api/m/<id>/<sub>" -> { module, handler }

  function machineEntry(id) {
    const all = opts.config.get().modules;
    if (!all || typeof all !== 'object' || Array.isArray(all)) return undefined;
    return all[id];
  }
  function isEnabled(rec) {
    const v = machineEntry(rec.id);
    if (typeof v === 'boolean') return v;
    if (v && typeof v === 'object' && typeof v.enabled === 'boolean') return v.enabled;
    return !!(rec.manifest && rec.manifest.enabledByDefault === true);
  }
  function settings(rec) {
    const v = machineEntry(rec.id);
    const out = Object.assign({}, rec.manifest.defaults || {}, v && typeof v === 'object' ? v : {});
    delete out.enabled;
    return out;
  }

  function readManifest(rec) {
    rec.manifest = null;
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(rec.dir, 'module.json'), 'utf8')); }
    catch (e) { rec.status = 'invalid'; rec.error = 'module.json missing or not valid JSON'; return; }
    if (!m || typeof m !== 'object' || m.id !== rec.id || !ID_RE.test(rec.id)) {
      rec.status = 'invalid';
      rec.error = 'module.json id "' + (m && m.id) + '" must match folder name "' + rec.id + '" (lowercase a-z, 0-9, -)';
      return;
    }
    rec.manifest = m;
  }

  function scan() {
    for (const base of opts.dirs) {
      let names = [];
      try { names = fs.readdirSync(base).sort(); } catch (e) { continue; }
      for (const name of names) {
        if (name.startsWith('.') || name.startsWith('_') || mods.has(name)) continue; // first dir wins
        const dir = path.join(base, name);
        try { if (!fs.statSync(dir).isDirectory()) continue; } catch (e) { continue; }
        const rec = { id: name, dir, manifest: null, status: 'off', error: '', instance: null, cleanup: [], loadedAt: null };
        mods.set(name, rec);
        readManifest(rec);
      }
    }
  }

  function makeCore(rec) {
    const id = rec.id;
    const track = fn => rec.cleanup.push(fn);
    return {
      id, dir: rec.dir, root: opts.root, vault: opts.vault,
      route(method, sub, handler) {
        const key = String(method).toUpperCase() + ' /api/m/' + id + '/' + String(sub).replace(/^\/+/, '');
        routes.set(key, { module: id, handler });
        track(() => routes.delete(key));
      },
      config: () => settings(rec),
      setConfig(patch) { const p = Object.assign({}, patch); delete p.enabled; opts.config.mergeModule(id, p); },
      events: {
        on(name, fn) { track(opts.bus.on(name, fn)); },
        emit(name, data) { opts.bus.emit(id + '.' + name, data); }
      },
      commands: {
        handle: (cmdId, fn) => opts.commands.handle(id, cmdId, fn),
        slot: (name, fn) => opts.commands.slot(id, name, fn),
        run: (text, ctx) => opts.commands.run(text, ctx),
        call: (cmdId, args, ctx) => opts.commands.call(cmdId, args, ctx),
        vocabulary: () => opts.commands.vocabulary()
      },
      notify: (text, level) => opts.bus.emit('core.toast', { module: id, text: String(text), level: level || 'info' }),
      log: (...a) => log('[' + id + ']', ...a)
    };
  }

  async function teardown(rec) {
    if (rec.instance && typeof rec.instance.stop === 'function') {
      try { await rec.instance.stop(); } catch (e) { log('[core] ' + rec.id + ' stop: ' + e.message); }
    }
    for (const fn of rec.cleanup.reverse()) { try { fn(); } catch (e) {} }
    rec.cleanup = []; rec.instance = null; rec.loadedAt = null;
    const prefix = rec.dir + path.sep; // fresh code on the next load
    for (const k of Object.keys(require.cache)) if (k.startsWith(prefix)) delete require.cache[k];
  }

  async function load(id, stack) {
    const rec = mods.get(id);
    if (!rec || !rec.manifest) return false;
    if (rec.status === 'loaded') return true;
    stack = stack || [];
    if (stack.indexOf(id) >= 0) { rec.status = 'failed'; rec.error = 'circular requires: ' + stack.concat(id).join(' → '); return false; }
    const m = rec.manifest;
    if (m.core !== CORE_VERSION) { rec.status = 'incompatible'; rec.error = 'written for core ' + m.core + ', this is core ' + CORE_VERSION; return false; }
    for (const dep of Array.isArray(m.requires) ? m.requires : []) {
      const d = mods.get(dep);
      if (!d || !d.manifest || !isEnabled(d)) {
        rec.status = 'failed'; rec.error = 'requires module "' + dep + '", which is ' + (d && d.manifest ? 'off' : 'not installed');
        return false;
      }
      if (!(await load(dep, stack.concat(id)))) {
        rec.status = 'failed'; rec.error = 'requires module "' + dep + '", which failed: ' + d.error;
        return false;
      }
    }
    try {
      rec.cleanup.push(() => opts.commands.unregisterModule(id));
      if (m.commands) opts.commands.register(id, JSON.parse(fs.readFileSync(path.join(rec.dir, m.commands), 'utf8')));
      if (m.server) {
        rec.instance = require(path.join(rec.dir, m.server));
        if (rec.instance && typeof rec.instance.init === 'function') await rec.instance.init(makeCore(rec));
      }
      rec.status = 'loaded'; rec.error = ''; rec.loadedAt = Date.now();
      return true;
    } catch (e) {
      await teardown(rec);
      rec.status = 'failed'; rec.error = e.message;
      log('[core] module ' + id + ' failed: ' + e.message);
      return false;
    }
  }

  async function loadAll() {
    for (const rec of mods.values()) {
      if (!rec.manifest) continue;
      if (isEnabled(rec)) await load(rec.id);
      else { rec.status = 'off'; rec.error = ''; }
    }
  }

  // Take down every loaded module whose requirement is no longer loaded, repeating until
  // nothing changes, so a -> b -> c chains go down together when c does.
  async function cascadeDown() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const other of mods.values()) {
        if (other.status !== 'loaded' || !other.manifest) continue;
        const reqs = Array.isArray(other.manifest.requires) ? other.manifest.requires : [];
        const gone = reqs.find(dep => !mods.has(dep) || mods.get(dep).status !== 'loaded');
        if (gone) {
          await teardown(other);
          other.status = 'failed'; other.error = 'requires module "' + gone + '", which is ' + mods.get(gone).status;
          changed = true;
        }
      }
    }
  }

  async function retryFailed() {
    for (const rec of mods.values()) if (rec.manifest && rec.status === 'failed' && isEnabled(rec)) await load(rec.id);
  }

  async function setEnabled(id, enabled) {
    const rec = mods.get(id);
    if (!rec || !rec.manifest) { const e = new Error('no such module: ' + id); e.status = 404; throw e; }
    opts.config.mergeModule(id, { enabled: !!enabled });
    if (rec.manifest.liveToggle === false) { opts.bus.emit('core.modules', null); return { restartRequired: true }; }
    if (enabled) {
      await load(id);
      await retryFailed();
    } else {
      await teardown(rec);
      rec.status = 'off'; rec.error = '';
      await cascadeDown();
    }
    opts.bus.emit('core.modules', null);
    return { restartRequired: false };
  }

  async function reload(id) {
    const rec = mods.get(id);
    if (!rec) { const e = new Error('no such module: ' + id); e.status = 404; throw e; }
    await teardown(rec);
    rec.status = 'off'; rec.error = '';
    readManifest(rec);
    if (rec.manifest && isEnabled(rec)) await load(id);
    await cascadeDown();
    await retryFailed();
    opts.bus.emit('core.modules', null);
  }

  async function stopAll() {
    for (const rec of Array.from(mods.values()).reverse()) if (rec.status === 'loaded') { await teardown(rec); rec.status = 'off'; }
  }

  function list() {
    return Array.from(mods.values()).map(rec => {
      const m = rec.manifest || {};
      let fromGit = false;
      try { fromGit = fs.existsSync(path.join(rec.dir, '.git')); } catch (e) {}
      return {
        id: rec.id, name: m.name || rec.id, version: m.version || '', description: m.description || '',
        touches: Array.isArray(m.touches) ? m.touches : [], status: rec.status, error: rec.error,
        enabled: rec.manifest ? isEnabled(rec) : false, manifestOk: !!rec.manifest,
        liveToggle: m.liveToggle !== false, hasPanel: !!m.panel, panel: m.panel || null, overlay: m.overlay || null,
        loadedAt: rec.loadedAt, fromGit
      };
    });
  }

  function route(method, pathname) {
    return routes.get(String(method).toUpperCase() + ' ' + pathname) || null;
  }

  function staticFile(id, rest) {
    const rec = mods.get(id);
    if (!rec || rec.status !== 'loaded' || !rec.manifest) return null;
    if (rec.manifest.panel && rest === rec.manifest.panel) return path.join(rec.dir, rec.manifest.panel);
    if (rec.manifest.overlay && rest === rec.manifest.overlay) return path.join(rec.dir, rec.manifest.overlay);
    if (!/^assets\//.test(rest) || rest.indexOf('\\') >= 0) return null; // no backslash tricks on any OS
    const assets = path.join(rec.dir, 'assets');
    const f = path.resolve(assets, rest.slice('assets/'.length));
    return f.startsWith(assets + path.sep) ? f : null;
  }

  function fallback() {
    for (const rec of mods.values()) {
      if (rec.status === 'loaded' && rec.instance && typeof rec.instance.fallback === 'function')
        return (req, res) => rec.instance.fallback(req, res);
    }
    return null;
  }

  // A module may own one top-level page, e.g. "page": { "path": "/status", "file": "assets/fullscreen.html" }.
  const RESERVED = new Set(['/api', '/m', '/shell', '/legacy', '/classic']);
  function page(pathname) {
    for (const rec of mods.values()) {
      const pg = rec.status === 'loaded' && rec.manifest && rec.manifest.page;
      if (!pg || pg.path !== pathname || RESERVED.has(pg.path) || !/^\/[a-z][a-z0-9-]*$/.test(String(pg.path))) continue;
      const f = staticFile(rec.id, String(pg.file || ''));
      if (f) return f;
    }
    return null;
  }

  return { scan, loadAll, setEnabled, reload, stopAll, list, route, staticFile, fallback, page };
}

module.exports = { createLoader, CORE_VERSION };
