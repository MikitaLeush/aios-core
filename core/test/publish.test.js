'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan, privateList, publish } = require('../publish.js');

// Emails, paths and tokens are built at runtime so this file itself publishes clean.
const AT = '@';
function tree(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
}
const fresh = (base, name) => { const d = path.join(base, name); fs.mkdirSync(d); return d; };

module.exports = async function (ok) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-publish-test-'));
  const root = path.join(base, 'vault');
  tree(root, {
    'core/server.js': 'ok', 'core/test/x.test.js': 'ok',
    'modules/modes/module.json': '{ "id": "modes", "public": true }', 'modules/modes/server.js': 'ok', 'modules/modes/__pycache__/a.pyc': 'x',
    'modules/legacy/module.json': '{ "id": "legacy" }', 'modules/legacy/server.js': 'wraps the vault',
    'modules/crm/module.json': '{ "id": "crm" }', 'modules/crm/clients.md': 'a client',
    'modules/thirdparty/module.json': '{ "id": "thirdparty", "public": true }', 'modules/thirdparty/.aios-source': 'https://example.invalid/x.git\n',
    'modules/cloned/module.json': '{ "id": "cloned", "public": true }', 'modules/cloned/.git/HEAD': 'ref', 'modules/cloned/x.js': 'theirs',
    'shell/app.js': 'ok', 'shell/design/theme.css': 'ok', 'shell/design/screens/home.html': 'sample person',
    'docs/architecture.md': 'ok',
    'projects/aios-v3/public/README.md': '# AIOS', 'projects/aios-v3/public-modules/README.md': '# modules', 'projects/aios-v3/public/LICENSE': 'MIT', 'projects/aios-v3/public/.gitignore': 'system/',
    'projects/inner/.git/HEAD': 'ref', 'projects/inner/notes.md': 'vault notes',
    'system/machine.json': '{}', 'tasks/tasks.md': '- [ ] x', 'system/publish-deny.txt': '# private words\nzorblax\n'
  });
  fs.writeFileSync(path.join(root, 'shell', 'design', 'font.woff2'), Buffer.from([0, 1, 2, 3, 0x41, 0x42])); // binary, nothing private
  const outside = path.join(base, 'outside');
  tree(outside, { 'diary.txt': 'private diary' });
  fs.symlinkSync(outside, path.join(root, 'modules', 'modes', 'linked'), 'junction');
  const priv = { words: ['zorblax'], names: [], strings: [{ value: 'https://calendar.example/priv-123/basic.ics', label: 'calendar link' }], allow: [] };

  const empty = fresh(base, 'out1');
  const r = publish(root, empty, priv);
  const want = ['.gitignore', 'LICENSE', 'README.md', 'core/server.js', 'core/test/x.test.js', 'docs/architecture.md',
    'shell/app.js', 'shell/design/font.woff2', 'shell/design/theme.css'];
  ok('base allowlist only: core, shell but screens, docs, README/LICENSE/.gitignore at the top — no modules', r.hits.length === 0 && r.files.slice().sort().join(',') === want.join(',') && !fs.existsSync(path.join(empty, 'modules')), JSON.stringify(r));
  ok('nothing private is copied (machine.json, tasks)', !fs.existsSync(path.join(empty, 'system')) && !fs.existsSync(path.join(empty, 'tasks')));

  const mods = fresh(base, 'outm');
  const rm = publish(root, mods, priv, 'modules');
  ok('modules repo: each public module at the top, plus its own README and the LICENSE', rm.hits.length === 0 && rm.files.slice().sort().join(',') === 'LICENSE,README.md,modes/module.json,modes/server.js' && fs.readFileSync(path.join(mods, 'README.md'), 'utf8') === '# modules', JSON.stringify(rm));
  ok('legacy and pycache stay home', !fs.existsSync(path.join(mods, 'legacy')) && !fs.existsSync(path.join(mods, 'modes', '__pycache__')));
  ok('a module without "public": true stays home (final review #7)', !fs.existsSync(path.join(mods, 'crm')));
  ok('an installed module (with .aios-source) is never published', !fs.existsSync(path.join(mods, 'thirdparty')));
  ok('a module cloned by hand into modules/ (has .git, no marker) is never published (M6b review I2)', !fs.existsSync(path.join(mods, 'cloned')));
  ok('a link inside an allowlisted folder is not followed (final review #3)', !fs.existsSync(path.join(mods, 'modes', 'linked')));

  const bad = [
    'mail me at someone' + AT + 'mail.com',
    'clone git' + AT + 'github.com:x/y.git, write to a' + AT + 'example.com',
    'path C:' + '\\Users\\bob\\x and /ho' + 'me/bob/x',
    'key gh' + 'p_' + 'a'.repeat(30),
    'Zorblax was here',
    'zorblaxPc and github.com/zorblaxdev',
    'feed https://calendar.example/priv-123/basic.ics'
  ].join('\n');
  const hits = scan([{ rel: 'core/a.js', text: bad }], priv, []);
  const kinds = hits.map(h => h.line + ':' + h.kind).join(',');
  ok('scan finds an email, two absolute paths, a token, a private word in any case, a secret (Review Focus 2)', kinds === '1:email,3:absolute path,3:absolute path,4:token,5:private word,6:private word,7:secret', kinds);
  ok('git' + AT + 'github.com and example addresses are not emails', !hits.some(h => h.line === 2));
  ok('a private word run together with others is still a hit (final review #5)', hits.some(h => h.line === 6));
  ok('a short OS user name only counts as a whole word', scan([{ rel: 'c.js', text: 'bobby\nhi bob' }], { words: [], names: ['bob'], strings: [] }, []).map(h => h.line).join(',') === '2');
  ok('a slash-separated list of words is not a home path', scan([{ rel: 'c.js', text: '// insert/menu/ho' + 'me/end keys, a/Us' + 'ers/x' }], priv, []).length === 0);
  ok('a secret is reported by its label, never its value', hits.find(h => h.kind === 'secret').match === 'calendar link');
  ok('an allowed line is let through', scan([{ rel: 'LICENSE', text: 'Copyright (c) 2026 Zorblax' }], priv, ['Copyright (c) 2026 Zorblax']).length === 0);

  // text the scanner must decode: UTF-16 (PowerShell's default) and words inside binaries
  tree(root, { 'modules/modes/audio.ps1': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# by zorblax\r\n', 'utf16le')]) });
  const r16 = publish(root, fresh(base, 'out16'), priv, 'modules');
  ok('a UTF-16 file is read as text and scanned (final review #4)', r16.hits.some(h => h.file === 'modes/audio.ps1' && h.kind === 'private word'), JSON.stringify(r16.hits));
  fs.unlinkSync(path.join(root, 'modules', 'modes', 'audio.ps1'));
  tree(root, { 'modules/modes/doc.pdf': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('Author: Zorblax')]) });
  const rbin = publish(root, fresh(base, 'outbin'), priv, 'modules');
  ok('a private word inside a binary file is a hit', rbin.hits.some(h => h.file === 'modes/doc.pdf' && h.kind === 'private word'), JSON.stringify(rbin.hits));
  fs.unlinkSync(path.join(root, 'modules', 'modes', 'doc.pdf'));

  let e1 = '';
  try { publish(root, path.join(root, 'core'), priv); } catch (e) { e1 = e.message; }
  ok('refuses a target inside the vault (Review Focus 1)', /outside the vault/.test(e1), e1);
  let e0 = '';
  try { publish(root, base, priv); } catch (e) { e0 = e.message; }
  ok('refuses a target that contains the vault', /outside the vault/.test(e0), e0);
  const viaLink = path.join(base, 'inner-link');
  fs.symlinkSync(path.join(root, 'projects', 'inner'), viaLink, 'junction');
  let e3 = '';
  try { publish(root, viaLink, priv); } catch (e) { e3 = e.message; }
  ok('refuses a link that points into the vault; its files stay (final review #1)', /outside the vault/.test(e3) && fs.readFileSync(path.join(root, 'projects', 'inner', 'notes.md'), 'utf8') === 'vault notes', e3);
  const messy = path.join(base, 'messy');
  tree(messy, { 'notes.txt': 'mine' });
  let e2 = '';
  try { publish(root, messy, priv); } catch (e) { e2 = e.message; }
  ok('refuses a folder with files and no .git — never deletes your files', /empty or a git checkout/.test(e2) && fs.readFileSync(path.join(messy, 'notes.txt'), 'utf8') === 'mine', e2);
  const other = path.join(base, 'other-project');
  tree(other, { '.git/HEAD': 'ref', '.env': 'KEY=1', 'src/app.js': 'x' });
  let e4 = '';
  try { publish(root, other, priv); } catch (e) { e4 = e.message; }
  ok('refuses a checkout holding files publish did not put there; they stay (final review #2)', /did not put there/.test(e4) && fs.readFileSync(path.join(other, '.env'), 'utf8') === 'KEY=1', e4);

  const repo = path.join(base, 'repo');
  tree(repo, { '.git/HEAD': 'ref', 'core/stale.js': 'x', 'README.md': 'old' });
  publish(root, repo, priv);
  ok('the public checkout: old published files replaced, .git kept', fs.existsSync(path.join(repo, '.git', 'HEAD')) && !fs.existsSync(path.join(repo, 'core', 'stale.js')) && fs.existsSync(path.join(repo, 'core', 'server.js')) && fs.readFileSync(path.join(repo, 'README.md'), 'utf8') === '# AIOS');

  const mrepo = path.join(base, 'mrepo');
  tree(mrepo, { '.git/HEAD': 'ref', 'gone/module.json': '{ "id": "gone" }' });
  publish(root, mrepo, priv, 'modules');
  ok('modules checkout: a module folder from an earlier publish is ours and is replaced', !fs.existsSync(path.join(mrepo, 'gone')) && fs.existsSync(path.join(mrepo, 'modes', 'module.json')) && fs.existsSync(path.join(mrepo, '.git', 'HEAD')));
  tree(mrepo, { 'notes.txt': 'mine' });
  let e5 = '';
  try { publish(root, mrepo, priv, 'modules'); } catch (e) { e5 = e.message; }
  ok('modules checkout: a stray file publish did not put there is refused', /did not put there/.test(e5), e5);
  fs.unlinkSync(path.join(mrepo, 'notes.txt'));

  tree(root, { 'modules/modes/leak.js': '// by Zorblax' });
  const before = fs.readdirSync(mrepo).sort().join(',') + '|' + fs.readdirSync(path.join(mrepo, 'modes')).sort().join(',');
  const r2 = publish(root, mrepo, priv, 'modules');
  const after = fs.readdirSync(mrepo).sort().join(',') + '|' + fs.readdirSync(path.join(mrepo, 'modes')).sort().join(',');
  ok('a hit aborts: listed with file and line, the target is left exactly as it was (Review Focus 3)', r2.hits.length === 1 && r2.hits[0].file === 'modes/leak.js' && r2.hits[0].line === 1 && r2.files.length === 0 && before === after, JSON.stringify(r2.hits));

  tree(root, { 'system/publish-allow.txt': 'Copyright line\n', 'system/machine.json': JSON.stringify({ lanToken: 'tok-abcdef123', modules: { status: { place: 'Zork City', icsUrl: 'webcal://calendar.example/priv-9/basic.ics' } } }) });
  const pl = privateList(root);
  ok('private list: deny-file words, the weather place, the OS user, the vault path, the calendar link (both forms), the LAN token', pl.words.includes('zorblax') && pl.words.includes('Zork City') && pl.names.length === 1 && pl.strings.some(s => s.label === 'vault path') && pl.strings.filter(s => s.label === 'calendar link').length === 2 && pl.strings.some(s => s.value === 'tok-abcdef123') && pl.allow[0] === 'Copyright line', JSON.stringify(pl.words));
  ok('comments in the deny file are ignored', !pl.words.some(w => w.startsWith('#')));
  fs.rmSync(base, { recursive: true, force: true });
};
