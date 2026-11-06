// Modules manager: per-machine on/off, failures with their reasons, install from a git URL
// (spec §4.6, §8.4 screen 3). Rendered by the shell, not a module, so it works even when
// every module is off. Markup mirrors shell/design/screens/modules*.html.
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const list = v => (Array.isArray(v) ? v : []);

export function renderManager(root, { api, toast, on }) {
  let alive = true;
  let lastToggled = null;
  let closeReview = null;
  const post = (url, data) => api(url, { method: 'POST', body: JSON.stringify(data) });

  root.innerHTML = '';
  const head = el('section');
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-end;gap:16px';
  const titles = el('div');
  const where = el('div', 'label', 'This computer');
  const h1 = el('h1', 'serif', 'Modules');
  h1.style.cssText = 'margin:8px 0 0;font-size:56px;line-height:1';
  titles.append(where, h1);
  const summary = el('p', 'muted');
  summary.style.cssText = 'margin:0;font-size:14px';
  head.append(titles, summary);

  const form = el('form', 'card');
  form.style.cssText = 'padding:20px 24px;display:flex;flex-direction:column;gap:10px';
  const urlLabel = el('label', 'muted', 'Install from git');
  urlLabel.htmlFor = 'mod-git'; urlLabel.style.fontSize = '14px';
  const row = el('div'); row.style.cssText = 'display:flex;gap:12px';
  const url = el('input', 'input'); url.id = 'mod-git'; url.type = 'url'; url.required = true;
  url.placeholder = 'https://github.com/someone/aios-module-x'; url.style.flex = '1';
  const inspectBtn = el('button', 'btn btn-primary', 'Inspect'); inspectBtn.type = 'submit';
  row.append(url, inspectBtn);
  const note = el('div', 'muted'); note.style.fontSize = '13px';
  form.append(urlLabel, row, note);

  const rows = el('section', 'card'); rows.style.padding = '24px 28px'; rows.setAttribute('aria-live', 'polite');
  root.append(head, form, rows);

  async function draw() {
    let r;
    try { r = await api('/api/core/modules'); } catch (e) { rows.textContent = e.message; return; }
    if (!alive) return;
    // Only the list is rebuilt; put keyboard focus back on the same toggle afterwards. A toggle
    // disables itself while saving, which drops focus to <body>, so remember the last one used.
    const active = document.activeElement;
    const had = active && rows.contains(active) ? active.dataset.moduleId
      : (!active || active === document.body ? lastToggled : null);
    where.textContent = 'This computer · ' + (r.machine || '');
    const count = s => r.modules.filter(m => m.status === s).length;
    summary.textContent = [count('loaded') + ' loaded', count('off') + ' off', count('failed') + ' failed']
      .concat(count('invalid') ? [count('invalid') + ' invalid'] : []).join(' · ');
    rows.innerHTML = '';
    r.modules.forEach((m, i) => {
      const mod = el('div', 'mod');
      mod.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 24px;padding:' +
        (i ? '20px' : '0') + ' 0 ' + (i === r.modules.length - 1 ? '0' : '20px') + ';' + (i ? 'border-top:1px solid var(--line)' : '');
      const title = el('div'); title.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap';
      const name = el('span', null, m.name || m.id); name.style.fontSize = '17px';
      title.appendChild(name);
      if (m.version) { const v = el('span', 'mono muted', m.version); v.style.fontSize = '12px'; title.appendChild(v); }
      title.appendChild(el('span', 'pill pill-' + m.status, m.status));
      mod.appendChild(title);
      if (m.manifestOk) {
        const lab = el('label', 'toggle');
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = m.enabled;
        cb.dataset.moduleId = m.id;
        cb.setAttribute('aria-label', 'Enable ' + (m.name || m.id));
        cb.addEventListener('change', async () => {
          lastToggled = m.id;
          cb.disabled = true;
          try {
            const res = await post('/api/core/modules/toggle', { id: m.id, enabled: cb.checked });
            if (res.restartRequired) toast((m.name || m.id) + ': restart AIOS to apply', 'warn');
          } catch (e) { toast(e.message, 'error'); cb.checked = !cb.checked; }
          cb.disabled = false;
        });
        lab.append(cb, el('span', 'track'), document.createTextNode('enabled'));
        mod.appendChild(lab);
      } else mod.appendChild(el('span'));
      const line = (cls, text) => { const d = el('div', cls, text); d.style.cssText = 'font-size:14px;grid-column:1/3'; mod.appendChild(d); return d; };
      const touches = list(m.touches);
      if (m.description || touches.length) line('muted', (m.description || '') + (m.description && touches.length ? ' · ' : '') + (touches.length ? 'Touches: ' + touches.join(' · ') : ''));
      if (m.error) { const er = line('error mono', 'error: ' + m.error); er.style.fontSize = '13px'; }
      if (m.fromGit) {
        const up = el('button', 'btn btn-sm', 'Update from git'); up.type = 'button'; up.style.justifySelf = 'start';
        up.addEventListener('click', async () => {
          up.disabled = true;
          try { await post('/api/core/modules/update', { id: m.id }); toast(m.id + ' updated', 'ok'); }
          catch (e) { toast(e.message, 'error'); }
          up.disabled = false;
        });
        mod.appendChild(up);
      }
      rows.appendChild(mod);
    });
    if (had) { const again = rows.querySelector('input[data-module-id="' + had + '"]'); if (again) again.focus(); }
  }
  if (on) on('core.modules', draw);

  // Review dialog (screens/modules-review.html): scrim + dialog, focus moves in, Esc/Cancel close.
  function review(u, r) {
    const m = r.manifest;
    const scrim = el('div', 'scrim');
    const dlg = el('div', 'dialog');
    dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-labelledby', 'dlg-title');
    const top = el('div'); top.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;gap:16px';
    const t = el('div');
    const h = el('h2', 'serif', (m.name || m.id) + ' '); h.id = 'dlg-title'; h.style.cssText = 'margin:6px 0 0;font-size:38px;line-height:1.05';
    const ver = el('span', 'mono muted', m.version || ''); ver.style.fontSize = '15px'; h.appendChild(ver);
    const desc = el('p', 'muted', m.description || ''); desc.style.margin = '6px 0 0';
    t.append(el('div', 'label', 'Review before install'), h, desc);
    const x = el('button', 'iconbtn'); x.type = 'button'; x.setAttribute('aria-label', 'Close (Esc)'); x.style.flexShrink = '0';
    x.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    top.append(t, x);
    const says = el('div'); says.style.cssText = 'margin-top:20px;font-size:15px';
    says.append(el('span', 'muted', 'Says it touches: '), document.createTextNode(list(m.touches).join(' · ') || 'nothing listed'));
    const warn = el('div', 'warn', "This list is the author's claim and is NOT enforced. A module runs as you: it can read the vault, use your Claude login and run commands. Install only code you trust.");
    warn.setAttribute('role', 'note');
    warn.style.cssText = 'margin-top:16px;padding:14px 16px;border-radius:16px;background:var(--warn-tint);border:1px solid rgba(232,194,122,.3);font-size:14px;line-height:1.5';
    const jl = el('div', 'label', 'module.json'); jl.style.margin = '20px 0 8px';
    const pre = el('pre', null, JSON.stringify(m, null, 2)); pre.style.maxHeight = '240px';
    const actions = el('div'); actions.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:24px';
    const cancel = el('button', 'btn', 'Cancel'); cancel.type = 'button';
    const go = el('button', 'btn btn-danger', r.exists ? 'Already installed' : 'Install (stays off)'); go.type = 'button'; go.disabled = r.exists;
    actions.append(cancel, go);
    dlg.append(top, says, warn, jl, pre, actions);
    document.body.append(scrim, dlg);

    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      scrim.remove(); dlg.remove(); closeReview = null; inspectBtn.focus();
    };
    const focusables = () => Array.from(dlg.querySelectorAll('button:not([disabled])'));
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Tab') { // keep focus inside the dialog
        const f = focusables(); if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    x.addEventListener('click', close); cancel.addEventListener('click', close); scrim.addEventListener('click', close);
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        await post('/api/core/modules/install', { url: u, confirm: true });
        toast(m.id + ' installed — turn it on when you are ready', 'ok');
        url.value = '';
        close();
        draw();
      } catch (err) { toast(err.message, 'error'); go.disabled = false; }
    });
    closeReview = close;
    (r.exists ? cancel : go).focus();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = url.value.trim();
    inspectBtn.disabled = true; inspectBtn.setAttribute('aria-busy', 'true');
    note.textContent = 'Cloning… nothing from it runs yet.';
    try { const r = await post('/api/core/modules/inspect', { url: u }); if (alive) review(u, r); }
    catch (err) { toast(err.message, 'error'); }
    note.textContent = '';
    inspectBtn.disabled = false; inspectBtn.removeAttribute('aria-busy');
  });

  draw();
  return { unmount() { alive = false; if (closeReview) closeReview(); root.innerHTML = ''; } };
}
