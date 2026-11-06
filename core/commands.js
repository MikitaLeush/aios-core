'use strict';
/* One command registry for voice (Viero), the Ctrl+K palette and Claude: same words in,
 * same result out. Matching is fuzzy per word (spec §5.4): close enough runs, a near miss
 * becomes "did you mean …?". */
const FILLERS = new Set(['viero', 'please', 'uh', 'um', 'hey', 'ok', 'okay']);

function normalize(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ')
    .split(' ').filter(w => w && !FILLERS.has(w)).join(' ');
}

function compile(pattern) {
  const parts = [];
  for (const tok of String(pattern).trim().split(/\s+/)) {
    const m = /^\{([a-z][a-z0-9_]*)\}$/.exec(tok);
    if (m) parts.push({ slot: m[1] });
    else for (const w of normalize(tok).split(' ')) if (w) parts.push({ word: w });
  }
  return parts;
}

const SURE = 0.8, UNSURE = 0.6;  // similarity bands (spec §5.4), tuned on the matcher table in core/test/commands.test.js
const SLOT_SURE = 0.7;           // each slot value on its own must be this close to run unasked ("close teams" ≠ steam)
const MAX_WORDS = 12;            // longer input is not a command (keeps backtracking small)
const MAX_FREE = 8;              // a free slot captures at most this many words
const budget = target => Math.max(1, Math.floor(target.length / 2)); // edits allowed per word / slot value

function lev(a, b) {
  if (a === b) return 0;
  const row = [];
  for (let j = 0; j <= b.length; j++) row[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return row[b.length];
}

// Best alignment of heard words to a pattern: each word is used once; literal words and slot
// values may be misheard (edit distance within budget); a slot value is compared with 1..n+2
// heard words joined, so "spot if eye" can be "spotify"; a free slot captures 1..MAX_FREE words
// as said. Returns { args, edits, chars, low (worst slot-value similarity), said[] } with the
// fewest edits, or null.
function align(words, parts, slotValues) {
  const better = (a, b) => !b || a.edits < b.edits || (a.edits === b.edits && a.chars > b.chars);
  function go(i, j) {
    if (j === parts.length) return i === words.length ? { args: {}, edits: 0, chars: 0, low: 1, said: [] } : null;
    if (i >= words.length) return null;
    const p = parts[j];
    if (p.word) {
      const d = lev(words[i], p.word);
      if (d > budget(p.word)) return null;
      const r = go(i + 1, j + 1);
      return r && { args: r.args, edits: r.edits + d, chars: r.chars + p.word.length, low: r.low, said: [p.word].concat(r.said) };
    }
    let best = null;
    const cands = slotValues(p.slot);
    if (cands) {
      for (const c of cands) {
        const target = c.words.join('');
        for (let n = 1; n <= Math.min(c.words.length + 2, words.length - i); n++) {
          const d = lev(words.slice(i, i + n).join(''), target);
          if (d > budget(target)) continue;
          const r = go(i + n, j + 1);
          if (!r) continue;
          const cand = { args: Object.assign({ [p.slot]: c.value }, r.args), edits: r.edits + d, chars: r.chars + target.length, low: Math.min(r.low, 1 - d / target.length), said: [c.value].concat(r.said) };
          if (better(cand, best)) best = cand;
        }
      }
      return best;
    }
    for (let n = 1; n <= Math.min(MAX_FREE, words.length - i); n++) {
      const r = go(i + n, j + 1);
      if (!r) continue;
      const cap = words.slice(i, i + n).join(' ');
      const cand = { args: Object.assign({ [p.slot]: cap }, r.args), edits: r.edits, chars: r.chars, low: r.low, said: [cap].concat(r.said) };
      if (better(cand, best)) best = cand;
    }
    return best;
  }
  return go(0, 0);
}

function createRegistry() {
  const commands = []; // { id, module, confirm, help, patterns: [{ text, parts }], handler }
  const slots = new Map(); // name -> { module, fn }

  function register(moduleId, defs) {
    if (!Array.isArray(defs)) throw new Error(moduleId + ': commands.json must be an array');
    for (const d of defs) {
      if (!d || typeof d.id !== 'string' || d.id.indexOf(moduleId + '.') !== 0)
        throw new Error('command id must start with "' + moduleId + '.": ' + JSON.stringify(d && d.id));
      if (commands.some(c => c.id === d.id)) throw new Error('duplicate command id ' + d.id);
      if (!Array.isArray(d.patterns) || !d.patterns.length) throw new Error(d.id + ': patterns must be a non-empty array');
      commands.push({ id: d.id, module: moduleId, confirm: d.confirm === true, help: String(d.help || ''),
        patterns: d.patterns.map(t => ({ text: String(t), parts: compile(t) })), handler: null });
    }
  }
  function handle(moduleId, id, fn) {
    const c = commands.find(x => x.id === id);
    if (!c || c.module !== moduleId) throw new Error('command ' + id + ' is not declared in ' + moduleId + '/commands.json');
    c.handler = fn;
  }
  function slot(moduleId, name, fn) { slots.set(name, { module: moduleId, fn }); }
  function unregisterModule(moduleId) {
    for (let i = commands.length - 1; i >= 0; i--) if (commands[i].module === moduleId) commands.splice(i, 1);
    for (const [k, v] of Array.from(slots)) if (v.module === moduleId) slots.delete(k);
  }
  function slotValues(name) {
    const s = slots.get(name);
    if (!s) return null;
    let vals;
    try { vals = s.fn(); } catch (e) { return []; }
    const out = [];
    for (const v of Array.isArray(vals) ? vals : []) {
      const value = typeof v === 'string' ? v : (v && v.value);
      if (!value) continue;
      const says = [value].concat(v && Array.isArray(v.aliases) ? v.aliases : []);
      for (const say of says) {
        const w = normalize(say).split(' ').filter(Boolean);
        if (w.length) out.push({ words: w, value });
      }
    }
    return out.sort((a, b) => b.words.length - a.words.length); // longest alias first
  }
  function match(text) {
    const words = normalize(text).split(' ').filter(Boolean);
    if (!words.length || words.length > MAX_WORDS) return null;
    let best = null;
    for (const c of commands) {
      for (const p of c.patterns) {
        const a = align(words, p.parts, slotValues);
        if (!a) continue;
        const sim = a.chars ? 1 - a.edits / a.chars : 1;
        if (sim < UNSURE) continue;
        const sure = sim >= SURE && a.low >= SLOT_SURE;
        // sure beats unsure; then the more specific pattern (literal words ×2 + constrained
        // slots); then the closer one; a full tie keeps registration order
        const spec = p.parts.filter(x => x.word).length * 2 + p.parts.filter(x => x.slot && slots.has(x.slot)).length;
        if (!best || sure > best.sure || (sure === best.sure && (spec > best.spec || (spec === best.spec && sim > best.sim))))
          best = { c, a, sim, sure, spec };
      }
    }
    return best && { id: best.c.id, module: best.c.module, args: best.a.args, confirm: best.c.confirm,
      score: Math.round(best.sim * 100) / 100, sure: best.sure, text: best.a.said.join(' ') };
  }
  async function run(text, ctx) {
    ctx = ctx || {};
    const t0 = Date.now();
    const m = match(text);
    const ms = { match: Date.now() - t0 };
    if (!m) return { ok: false, matched: false, text: String(text || ''), ms };
    if (!m.sure) return { ok: false, matched: false, text: String(text || ''), suggestion: { text: m.text, command: m.id, score: m.score }, ms };
    const c = commands.find(x => x.id === m.id);
    const base = { matched: true, command: m.id, phrase: m.text, args: m.args };
    if (!c.handler) return Object.assign({ ok: false, error: 'no handler registered for ' + m.id, ms }, base);
    if (c.confirm && ctx.confirmed !== true) return Object.assign({ ok: false, needsConfirm: true, ms }, base);
    const t1 = Date.now();
    try {
      const r = await c.handler(m.args, ctx);
      return Object.assign({ ok: true }, r && typeof r === 'object' ? r : {}, base, { ms: { match: ms.match, action: Date.now() - t1 } });
    } catch (e) {
      return Object.assign({ ok: false, error: e.message }, base, { ms: { match: ms.match, action: Date.now() - t1 } });
    }
  }
  // Run a declared handler by id, no matching, no confirm gate: for callers that already know the command.
  async function call(id, args, ctx) {
    const c = commands.find(x => x.id === id);
    if (!c || !c.handler) return { ok: false, missing: true, command: id, error: 'no command ' + id };
    try {
      const r = await c.handler(args || {}, ctx || {});
      return Object.assign({ ok: true }, r && typeof r === 'object' ? r : {}, { command: id });
    } catch (e) {
      return { ok: false, command: id, error: e.message };
    }
  }

  // Phrases a person can say, for the speech-to-text prompt: constrained slots expanded
  // with every value and alias; a free slot's words are unknown, so it is left out. Every
  // command's first pattern comes before any alternate, so a length-capped prompt keeps them all.
  function vocabulary() {
    const out = new Set();
    const rounds = Math.max(0, ...commands.map(c => c.patterns.length));
    for (let i = 0; i < rounds; i++) for (const c of commands) {
      const p = c.patterns[i];
      if (!p) continue;
      let phrases = [''];
      for (const part of p.parts) {
        if (part.word) { phrases = phrases.map(s => s + ' ' + part.word); continue; }
        const vals = slotValues(part.slot);
        if (!vals) continue;
        const says = Array.from(new Set(vals.map(v => v.words.join(' '))));
        phrases = [].concat(...phrases.map(s => says.map(w => s + ' ' + w))).slice(0, 50);
      }
      for (const s of phrases) if (s.trim()) out.add(s.trim());
    }
    return Array.from(out);
  }
  function list() {
    return commands.map(c => ({ id: c.id, module: c.module, patterns: c.patterns.map(p => p.text), confirm: c.confirm, help: c.help, ready: !!c.handler }));
  }
  return { register, handle, slot, unregisterModule, match, run, call, list, vocabulary };
}

module.exports = { createRegistry, normalize };
