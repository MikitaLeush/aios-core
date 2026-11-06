'use strict';
/* Copy the public part of AIOS into a separate checkout (spec §12). Two repos:
 *   node core/publish.js <target-folder>             base: core, shell, docs — no modules
 *   node core/publish.js --modules <target-folder>   every public module, one folder each
 * Users install a module from the second with `<repo-url>#<id>` on the Modules screen.
 * Allowlist only. The copy is staged in a temp folder and scanned for emails, absolute paths,
 * tokens, private words and secret values; any hit aborts with a list and the target is left
 * untouched. Private words come from system/publish-deny.txt (one per line, never published)
 * and the OS user; secrets from machine.json. system/publish-allow.txt holds exact strings a
 * line may contain to be let through (e.g. an intended copyright line). It never pushes. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SKIP = name => name === 'node_modules' || name === '__pycache__' || name === '.git' || /\.pyc$/.test(name) || /\.tmp-/.test(name);
// design mockups carry sample personal text; the runtime never loads them
const EXCLUDE = new Set(['shell/design/screens']);
// everything publish ever writes at the top of the target; anything else there is not ours to delete
// (in the modules repo a top-level folder holding a module.json is ours too)
const TOP = new Set(['.git', 'core', 'shell', 'docs', 'README.md', 'LICENSE', '.gitignore']);
// only modules that say "public": true go out; legacy and every private module stay home,
// and so does anything installed (.aios-source) or cloned by hand (.git): that is another repo's code
const isPublic = dir => { try { return !fs.existsSync(path.join(dir, '.aios-source')) && !fs.existsSync(path.join(dir, '.git')) && JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8')).public === true; } catch (e) { return false; } };

function sources(root, kind) {
  const out = [];
  const add = (rel, dest) => { if (fs.existsSync(path.join(root, rel))) out.push({ src: path.join(root, rel), dest: dest || rel }); };
  if (kind === 'modules') {
    const mods = path.join(root, 'modules');
    for (const id of fs.existsSync(mods) ? fs.readdirSync(mods).sort() : [])
      if (isPublic(path.join(mods, id))) add('modules/' + id, id);
    add('projects/aios-v3/public-modules/README.md', 'README.md');
    add('projects/aios-v3/public/LICENSE', 'LICENSE');
    return out;
  }
  add('core');
  add('shell');
  add('docs');
  for (const f of ['README.md', 'LICENSE', '.gitignore']) add('projects/aios-v3/public/' + f, f);
  return out;
}

function copyTree(src, dest, rel, files) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) return; // links (and Windows junctions) could lead anywhere: never followed
  if (st.isDirectory()) {
    if (EXCLUDE.has(rel)) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) if (!SKIP(name)) copyTree(path.join(src, name), path.join(dest, name), rel + '/' + name, files);
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    files.push(rel);
  }
}

const RULES = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    m => !/^git@github\.com$/i.test(m) && !/@(?:example\.(?:com|org|net)|[A-Za-z0-9.-]+\.(?:invalid|test|localhost))$/i.test(m)],
  ['absolute path', /\b[A-Za-z]:(?:\\\\?|\/)(?:Users|home)(?:\\\\?|\/)[^\s'"`<>]+|(?<![\w.\/-])\/(?:home|Users)\/[A-Za-z0-9._-]+/g], // "menu/home/end" is words, not a path
  ['token', /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/g]
];
const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Bytes → text to scan. UTF-16 (PowerShell's default) is decoded; a binary is scanned only for
// private words and secrets, in both one-byte and UTF-16 readings (pattern rules would be noise).
function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le') };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1))).swap16().toString('utf16le') };
  if (!buf.includes(0)) return { text: buf.toString('utf8') };
  return { text: buf.toString('latin1') + '\n' + buf.toString('utf16le'), binary: true };
}

function scan(files, priv, allow) {
  const hits = [];
  // deny-file words match anywhere ("zorblaxPc" too); the OS user name (may be short) only as a whole word
  const words = (priv.words || []).filter(w => w.length >= 3).map(w => new RegExp('()(' + reEscape(w) + ')', 'i'));
  const names = (priv.names || []).filter(w => w.length >= 3).map(w => new RegExp('(^|[^A-Za-z0-9])(' + reEscape(w) + ')(?![A-Za-z0-9])', 'i'));
  const strings = priv.strings.filter(s => s.value && s.value.length >= 6).map(s => ({ low: s.value.toLowerCase(), label: s.label }));
  for (const f of files) {
    f.text.split(/\r?\n/).forEach((line, i) => {
      if ((allow || []).some(a => a && line.includes(a))) return;
      const add = (kind, match) => hits.push({ file: f.rel, line: i + 1, kind, match });
      if (!f.binary) for (const [kind, re, keep] of RULES) for (const m of line.match(re) || []) if (!keep || keep(m)) add(kind, m);
      for (const re of words.concat(names)) { const m = re.exec(line); if (m) add('private word', m[2]); }
      const low = line.toLowerCase();
      for (const s of strings) if (low.includes(s.low)) add('secret', s.label);
    });
  }
  return hits;
}

function privateList(root) {
  const lines = f => {
    try { return fs.readFileSync(path.join(root, 'system', f), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')); }
    catch (e) { return []; }
  };
  const words = lines('publish-deny.txt');
  const names = [];
  try { names.push(os.userInfo().username); } catch (e) { /* no user name on this system */ }
  const strings = [];
  const paths = (p, label) => {
    for (const v of new Set([p, p.split(path.sep).join('/'), p.split(path.sep).join('\\\\')])) strings.push({ value: v, label });
  };
  paths(path.resolve(root), 'vault path');
  paths(os.homedir(), 'home folder');
  let m = {};
  try { m = JSON.parse(fs.readFileSync(path.join(root, 'system', 'machine.json'), 'utf8')) || {}; } catch (e) { /* none yet */ }
  const status = (m.modules && m.modules.status) || {};
  if (typeof status.place === 'string' && status.place.trim()) words.push(status.place.trim()); // where the owner lives
  const ics = status.icsUrl;
  if (typeof ics === 'string' && ics) {
    const other = /^webcal:/i.test(ics) ? ics.replace(/^webcal:/i, 'https:') : ics.replace(/^https:/i, 'webcal:');
    strings.push({ value: ics, label: 'calendar link' }, { value: other, label: 'calendar link' });
  }
  if (typeof m.lanToken === 'string' && m.lanToken) strings.push({ value: m.lanToken, label: 'LAN token' });
  return { words, names, strings, allow: lines('publish-allow.txt') };
}

function publish(root, target, priv, kind) {
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error('the target folder does not exist — make it, or git clone the public repo, first');
  // real paths: a link or junction must not hide that the target is (inside) the vault
  root = fs.realpathSync.native(path.resolve(root));
  target = fs.realpathSync.native(path.resolve(target));
  const inside = (a, b) => { const r = path.relative(a, b); return !r || (!r.startsWith('..') && !path.isAbsolute(r)); };
  if (inside(root, target) || inside(target, root)) throw new Error('the target must be outside the vault (and must not contain it)');
  const existing = fs.readdirSync(target);
  if (existing.length && !existing.includes('.git')) throw new Error('the target must be empty or a git checkout (it has files and no .git)');
  const ours = n => kind === 'modules' ? n === '.git' || n === 'README.md' || n === 'LICENSE' || fs.existsSync(path.join(target, n, 'module.json')) : TOP.has(n);
  const strange = existing.filter(n => !ours(n));
  if (strange.length) throw new Error('the target has files publish did not put there (' + strange.slice(0, 5).join(', ') + ') — publish only into the public repo\'s own checkout');
  priv = priv || privateList(root);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-publish-'));
  try {
    const files = [];
    for (const s of sources(root, kind)) copyTree(s.src, path.join(stage, s.dest), s.dest, files);
    const texts = [];
    for (const rel of files) {
      texts.push(Object.assign({ rel }, decode(fs.readFileSync(path.join(stage, rel)))));
    }
    const hits = scan(texts, priv, priv.allow);
    if (hits.length) return { files: [], hits };
    for (const name of existing) if (name !== '.git') fs.rmSync(path.join(target, name), { recursive: true, force: true });
    fs.cpSync(stage, target, { recursive: true });
    return { files, hits: [] };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = { sources, scan, privateList, publish };

if (require.main === module) {
  const kind = process.argv[2] === '--modules' ? 'modules' : 'base';
  const target = process.argv[kind === 'modules' ? 3 : 2];
  if (!target) { console.error('usage: node core/publish.js [--modules] <target-folder>'); process.exit(2); }
  try {
    const r = publish(path.resolve(__dirname, '..'), target, null, kind);
    if (r.hits.length) {
      console.error('NOT published: ' + r.hits.length + ' private thing(s) found, nothing in the target changed.');
      for (const h of r.hits) console.error('  ' + h.file + ':' + h.line + '  ' + h.kind + ': ' + h.match);
      process.exit(1);
    }
    console.log('published ' + r.files.length + ' files. Review with `git status` / `git diff` in the target, then commit and push yourself.');
  } catch (e) {
    console.error('publish: ' + e.message);
    process.exit(1);
  }
}
