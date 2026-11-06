'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createInstaller, validUrl } = require('../install.js');

const FIX = path.join(__dirname, 'fixtures', 'modules');

module.exports = async function (ok) {
  ok('https URL is valid', validUrl('https://github.com/a/b'));
  ok('git@ URL is valid', validUrl('git@github.com:a/b.git'));
  ok('option-looking URL is refused', !validUrl('-oProxyCommand=calc'));
  ok('file:// is refused', !validUrl('file:///C:/x'));
  ok('plain http is refused', !validUrl('http://example.com/x'));
  ok('non-string is refused', !validUrl(null) && !validUrl(42));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-install-test-'));
  const modulesDir = path.join(tmp, 'modules');
  fs.mkdirSync(modulesDir);
  let source = 'hello';
  const clone = (url, dest, cb) => { fs.cpSync(path.join(FIX, source), dest, { recursive: true }); cb(null); };
  const inst = createInstaller({ modulesDir, tmpRoot: tmp, clone, pull: (dir, cb) => cb(null, 'Already up to date.') });

  let threw = '';
  try { inst.install('https://x/hello'); } catch (e) { threw = e.message; }
  ok('install before inspect is refused', /inspect this URL first/.test(threw), threw);

  const r = await inst.inspect('https://x/hello');
  ok('inspect returns the manifest without installing', r.manifest.id === 'hello' && r.exists === false && !fs.existsSync(path.join(modulesDir, 'hello')));
  const done = inst.install('https://x/hello');
  ok('install moves the module into modules/<id>', done.id === 'hello' && fs.existsSync(path.join(modulesDir, 'hello', 'module.json')));
  ok('install writes .aios-source with the URL', fs.readFileSync(path.join(modulesDir, 'hello', '.aios-source'), 'utf8') === 'https://x/hello\n');
  threw = '';
  try { inst.install('https://x/hello'); } catch (e) { threw = e.message; }
  ok('a URL is used once per inspect', /inspect this URL first/.test(threw), threw);

  const again = await inst.inspect('https://x/hello');
  ok('inspect reports an existing install', again.exists === true);
  threw = '';
  try { inst.install('https://x/hello'); } catch (e) { threw = e.message; }
  ok('install refuses to overwrite', /already exists/.test(threw), threw);

  source = 'no-manifest';
  threw = '';
  try { await inst.inspect('https://x/empty'); } catch (e) { threw = e.message; }
  ok('repo without module.json is refused', /no valid module\.json/.test(threw), threw);

  threw = '';
  try { await inst.update('hello'); } catch (e) { threw = e.message; }
  ok('update refuses a module not installed from git', /not installed from git/.test(threw), threw);
  fs.mkdirSync(path.join(modulesDir, 'hello', '.git'));
  ok('update pulls a git module', (await inst.update('hello')) === 'Already up to date.');

  // a repo holding several modules (the public aios-modules repo): <url>#<folder>
  const many = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-install-many-'));
  fs.cpSync(path.join(FIX, 'hello'), path.join(many, 'greeter'), { recursive: true });
  fs.writeFileSync(path.join(many, 'greeter', 'module.json'), JSON.stringify({ id: 'greeter' }));
  fs.mkdirSync(path.join(many, '.git'));
  const cloned = [];
  const inst2 = createInstaller({ modulesDir: path.join(tmp, 'fresh-modules'), tmpRoot: tmp,
    clone: (url, dest, cb) => { cloned.push(url); fs.cpSync(many, dest, { recursive: true }); cb(null); } });
  const r2 = await inst2.inspect('https://x/aios-modules.git#greeter');
  ok('#folder: git clones the repo without the #part and reads that folder\'s module.json', cloned[0] === 'https://x/aios-modules.git' && r2.manifest.id === 'greeter');
  inst2.install('https://x/aios-modules.git#greeter');
  const g = path.join(tmp, 'fresh-modules', 'greeter');
  ok('#folder install: creates a missing modules/ folder, takes only that folder, records the full URL', fs.existsSync(path.join(g, 'module.json')) && !fs.existsSync(path.join(g, '.git')) && !fs.existsSync(path.join(g, 'greeter')) && fs.readFileSync(path.join(g, '.aios-source'), 'utf8') === 'https://x/aios-modules.git#greeter\n');
  ok('#folder install leaves no temp clone behind', !fs.readdirSync(tmp).some(n => n.startsWith('aios-mod-')));
  threw = '';
  try { await inst2.inspect('https://x/aios-modules.git#nope'); } catch (e) { threw = e.message; }
  ok('#folder that is not in the repo is refused', /no valid module\.json in nope/.test(threw), threw);
  threw = '';
  try { await inst2.inspect('https://x/aios-modules.git#../evil'); } catch (e) { threw = e.message; }
  ok('#folder must be a plain module name (no ../)', /module folder name/.test(threw), threw);
  fs.rmSync(many, { recursive: true, force: true });

  threw = '';
  try { await inst.inspect('-oProxyCommand=calc'); } catch (e) { threw = e.message; }
  ok('inspect validates the URL before running git', /only https/.test(threw), threw);

  fs.rmSync(tmp, { recursive: true, force: true });
};
