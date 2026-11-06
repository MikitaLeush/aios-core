// AIOS shell logic. The look lives in shell/design/ (Claude Design export, no logic); this
// file only finds the slots and mounts modules into them (spec §8). No build step.
import { renderManager } from './manager.js';

const slot = name => document.querySelector('[data-slot="' + name + '"]');
const listeners = new Map(); // SSE event name -> Set<fn>
const state = { modules: [], machine: '' };
let current = null; // { id, key, handle, dispose }

// LAN: /?t=<token> (printed by the start banner) is kept for this tab and sent on every
// call. Same sessionStorage key as the legacy dashboard, so its iframe picks it up too.
const TOKEN = (() => {
  try {
    const t = new URL(location.href).searchParams.get('t');
    if (t) sessionStorage.setItem('aios-token', t);
    return sessionStorage.getItem('aios-token') || '';
  } catch (e) { return ''; }
})();

async function api(url, opts) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { 'x-aios-token': TOKEN } : {});
  const r = await fetch(url, Object.assign({ headers }, opts || {}));
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
  return body;
}
const post = (url, data) => api(url, { method: 'POST', body: JSON.stringify(data) });

function toast(text, level) {
  const el = document.createElement('div');
  el.className = 'toast toast-' + (level || 'info');
  el.setAttribute('role', 'status');
  el.textContent = String(text);
  slot('toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function on(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name).delete(fn);
}

async function runCommand(text, extra) {
  try {
    let r = await post('/api/core/run', Object.assign({ text, source: 'palette' }, extra || {}));
    if (r.needsConfirm && window.confirm('Run "' + r.command + '"?'))
      r = await post('/api/core/run', { text, source: 'palette', confirmed: true });
    if (!r.matched && r.suggestion) {
      if (window.confirm('Did you mean "' + r.suggestion.text + '"?')) return runCommand(r.suggestion.text, extra);
      return r;
    }
    if (!r.matched) toast('No command matches "' + text + '"', 'warn');
    else if (r.ok) toast(r.toast || r.say || ('Done: ' + r.command), r.level || 'ok');
    else if (!r.needsConfirm) toast(r.error || 'Failed', 'error');
    return r;
  } catch (e) { toast(e.message, 'error'); return { ok: false, error: e.message }; }
}

function keyOf(id) {
  if (id === '_modules') return 'manager'; // redraws its own list on core.modules, keeping focus
  const m = state.modules.find(x => x.id === id);
  return m && m.status === 'loaded' ? String(m.loadedAt) : 'off';
}

function makeCtx(id, own) {
  return {
    api: (sub, opts) => opts && opts.body !== undefined ? post('/api/m/' + id + '/' + sub, opts.body) : api('/api/m/' + id + '/' + sub, opts),
    on: (name, fn) => { const off = on(name, fn); own.push(off); return off; },
    run: runCommand,
    notify: toast
  };
}

async function open(id) {
  if (current) {
    try { if (current.handle && current.handle.unmount) current.handle.unmount(); } catch (e) { console.error(e); }
    current.dispose();
    current = null;
  }
  const panel = slot('panel');
  panel.innerHTML = '';
  for (const b of slot('sidebar').querySelectorAll('[data-module]'))
    b.setAttribute('aria-current', b.dataset.module === id ? 'page' : 'false');
  try { localStorage.setItem('aios.panel', id); } catch (e) {}
  if (id === '_modules') {
    const own = [];
    const track = (name, fn) => { const off = on(name, fn); own.push(off); return off; };
    current = { id, key: keyOf(id), handle: renderManager(panel, { api, toast, on: track }), dispose: () => own.forEach(off => off()) };
    return;
  }
  const mod = state.modules.find(m => m.id === id && m.status === 'loaded' && m.hasPanel);
  if (!mod) { panel.innerHTML = '<div class="empty">This module is off or has no panel.</div>'; return; }
  const own = [];
  const ctx = makeCtx(id, own);
  const dispose = () => own.forEach(off => off());
  try {
    const m = await import('/m/' + id + '/' + mod.panel + '?v=' + encodeURIComponent(mod.version + '-' + mod.loadedAt));
    current = { id, key: keyOf(id), handle: m.mount(panel, ctx) || null, dispose };
  } catch (e) {
    dispose();
    const err = document.createElement('div');
    err.className = 'error';
    err.textContent = id + ' panel failed to load: ' + e.message;
    panel.appendChild(err);
    current = { id, key: keyOf(id), handle: null, dispose() {} };
  }
}

// Module overlays (module.json "overlay") live in data-slot="overlay" while their module is loaded.
const overlays = new Map(); // id → { key, el, handle, own }
async function syncOverlays() {
  const want = new Map(state.modules.filter(m => m.status === 'loaded' && m.overlay).map(m => [m.id, m]));
  for (const [id, o] of Array.from(overlays)) {
    if (want.has(id) && want.get(id).loadedAt === o.key) continue;
    try { if (o.handle && o.handle.unmount) o.handle.unmount(); } catch (e) { console.error(e); }
    o.own.forEach(off => off());
    o.el.remove();
    overlays.delete(id);
  }
  for (const [id, m] of want) {
    if (overlays.has(id)) continue;
    const o = { key: m.loadedAt, el: document.createElement('div'), handle: null, own: [] };
    overlays.set(id, o);
    slot('overlay').appendChild(o.el);
    try {
      const mod = await import('/m/' + id + '/' + m.overlay + '?v=' + encodeURIComponent(m.version + '-' + m.loadedAt));
      if (overlays.get(id) !== o) continue; // the module reloaded or went off while this was loading
      o.handle = mod.mount(o.el, makeCtx(id, o.own)) || null;
    } catch (e) { console.error(id + ' overlay failed to load: ' + e.message); }
  }
}

// Markup mirrors shell/design/screens/*.html so the design's classes apply as drawn.
function renderSidebar() {
  const nav = slot('sidebar');
  nav.innerHTML = '';
  const items = state.modules.filter(m => m.status === 'loaded' && m.hasPanel).map(m => ({ id: m.id, name: m.name }));
  items.push({ id: '_modules', name: 'Modules' });
  for (const it of items) {
    const a = document.createElement('a');
    a.className = 'nav-item'; a.href = '#' + it.id; a.dataset.module = it.id; a.textContent = it.name;
    if (it.id === '_modules') a.style.marginTop = '20px';
    a.setAttribute('aria-current', current && current.id === it.id ? 'page' : 'false');
    a.addEventListener('click', (e) => { e.preventDefault(); open(it.id); });
    nav.appendChild(a);
  }
}

function renderTopbar() {
  const top = slot('topbar');
  top.innerHTML = '';
  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--accent)" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg>aios';
  const form = document.createElement('form');
  form.className = 'palette'; form.setAttribute('role', 'search');
  form.innerHTML = '<span class="mono" style="color:var(--accent)" aria-hidden="true">&gt;</span><label for="palette" class="sr">Command</label>' +
    '<input id="palette" autocomplete="off" placeholder="Command — e.g. game mode"><span class="kbd">Ctrl K</span>';
  const input = form.querySelector('input');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = input.value.trim();
    if (!t) return;
    input.value = '';
    await runCommand(t);
  });
  const right = document.createElement('div');
  right.className = 'tb-right';
  const name = document.createElement('span');
  name.className = 'muted'; name.textContent = state.machine;
  right.appendChild(name);
  top.append(brand, form, right);
}

async function refresh() {
  try {
    const r = await api('/api/core/modules');
    state.modules = r.modules; state.machine = r.machine;
  } catch (e) { toast('Core unreachable: ' + e.message, 'error'); return; }
  renderSidebar();
  syncOverlays();
  if (current && keyOf(current.id) !== current.key) open(current.id);
}

function connectEvents() {
  const es = new EventSource('/api/events' + (TOKEN ? '?t=' + encodeURIComponent(TOKEN) : ''));
  es.onmessage = (msg) => {
    let ev; try { ev = JSON.parse(msg.data); } catch (e) { return; }
    if (ev.name === 'core.toast' && ev.data) toast(ev.data.text, ev.data.level);
    if (ev.name === 'core.modules') refresh();
    for (const fn of Array.from(listeners.get(ev.name) || [])) { try { fn(ev.data); } catch (e) { console.error(e); } }
  };
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    const i = document.getElementById('palette');
    if (i) i.focus();
  }
});

(async function start() {
  await refresh();
  renderTopbar();
  connectEvents();
  let first = null;
  try { first = localStorage.getItem('aios.panel'); } catch (e) {}
  const usable = id => id === '_modules' || state.modules.some(m => m.id === id && m.status === 'loaded' && m.hasPanel);
  const fallback = (state.modules.find(m => m.status === 'loaded' && m.hasPanel) || { id: '_modules' }).id;
  open(first && usable(first) ? first : fallback);
})();
