'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createVault, forRoot } = require('../vault.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aios-vault-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const hasGit = () => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } };

module.exports = async function (ok) {
  {
    const root = tmp(), v = createVault(root, { history: false });
    ok('read of a missing file is null', v.read('nope.md') === null);
    v.write('a/b.md', 'x\n');
    ok('write creates folders, content exact, no temp file left',
      fs.readFileSync(path.join(root, 'a', 'b.md'), 'utf8') === 'x\n' && fs.readdirSync(path.join(root, 'a')).join() === 'b.md',
      fs.readdirSync(path.join(root, 'a')).join());
    v.write('t.md', 'a');
    v.append('t.md', 'b');
    ok('append after a file without a final newline', v.read('t.md') === 'a\nb\n', JSON.stringify(v.read('t.md')));
    v.append('new/first.md', 'only');
    ok('append to a missing file starts on line 1 (no blank first line)', v.read('new/first.md') === 'only\n', JSON.stringify(v.read('new/first.md')));
    // a locked file (antivirus, editor) must not read as "empty" and be overwritten (M6a review)
    const real = fs.readFileSync, locked = path.join(root, 't.md');
    fs.readFileSync = (p, ...a) => { if (path.resolve(String(p)) === locked) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); return real(p, ...a); };
    let busy = '';
    try { v.append('t.md', 'c'); } catch (e) { busy = e.code || e.message; }
    fs.readFileSync = real;
    ok('append to a file that cannot be read throws and keeps the file', busy === 'EBUSY' && v.read('t.md') === 'a\nb\n', busy + ' ' + JSON.stringify(v.read('t.md')));
    let threw = '';
    try { v.safeJoin('../x'); } catch (e) { threw = e.message; }
    ok('a path outside the root is refused', /path escape/.test(threw) && v.read('../x') === null, threw);
    await wait(50);
    ok('history: false never creates .aios-history', !fs.existsSync(path.join(root, '.aios-history')));
  }
  if (!hasGit()) ok('writes in a burst become one snapshot, message names every why (git missing, skipped)', true);
  else {
    const root = tmp(), v = createVault(root, { delayMs: 30 });
    v.write('tasks/tasks.md', '- [ ] a\n', 'tasks add');
    v.write('tasks/tasks.md', '- [x] a\n', 'tasks toggle');
    v.append('tasks/tasks.md', '- [ ] b', 'tasks add');
    let log = '';
    for (let i = 0; i < 30 && !log; i++) {
      await wait(200);
      try { log = execFileSync('git', ['--git-dir=' + path.join(root, '.aios-history'), 'log', '--format=%s'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) {}
    }
    ok('writes in a burst become one snapshot, message names every why', log === 'aios: tasks add tasks toggle', JSON.stringify(log));
  }
  {
    const r = tmp();
    ok('forRoot gives one vault per root', forRoot(r) === forRoot(r + path.sep));
  }
};
