'use strict';
/* Vault I/O + undo history (spec §3), moved out of system/server.js. Modules get it as
 * core.vault; legacy shares the same instance via forRoot, so there is one debounce timer
 * and one history repo per vault.
 *
 * History snapshots: this used to commit into the vault's own .git. It never worked: the
 * vault repo carries the *system* only and .gitignore excludes ops/ tasks/ chats/ wiki/
 * projects/, so `git add -A` staged nothing and the "undo history" was empty. Snapshots now
 * go to a SEPARATE repo at .aios-history/ (a bare git dir, work-tree = vault root) with its
 * own exclude file, so:
 *   - vault data is genuinely versioned and restorable
 *   - the shared repo still carries no client/money data
 *   - nothing is written inside .git, which Syncthing would otherwise replicate
 * Writes are debounced: a burst (archive = two writes) becomes one commit.
 * Restore:  git --git-dir=.aios-history --work-tree=. log --  ops/clients
 *           git --git-dir=.aios-history --work-tree=. checkout <sha> -- <path> */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// `git add` always honours .gitignore files found in the work tree, and the vault's
// .gitignore excludes exactly the data we are trying to version. So stage with -f
// (ignore rules off) and carve out the noise with pathspecs instead.
const HISTORY_EXCLUDES = ['.aios-history', 'node_modules', '.stversions', '.stfolder',
  '.obsidian', 'system/machine.json', '*.tmp-*', 'briefing.md']
  .map(s => ':(exclude)' + s);

function writeFileAtomic(abs, data) {
  // temp file in same dir + rename, so a crash can never truncate the target
  const tmp = abs + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, abs);
}

function createVault(root, opts) {
  opts = opts || {};
  const ROOT = path.resolve(root);
  const HISTORY_DIR = path.join(ROOT, '.aios-history');
  const history = opts.history !== false;
  const delayMs = opts.delayMs == null ? 8000 : opts.delayMs;
  let histTimer = null, histRoutes = new Set(), histReady = false;

  function safeJoin(rel) {
    const p = path.resolve(ROOT, rel);
    if (p !== ROOT && !p.startsWith(ROOT + path.sep)) throw new Error('path escape');
    return p;
  }
  function historyGit(args, cb) {
    execFile('git', ['--git-dir=' + HISTORY_DIR, '--work-tree=' + ROOT,
      '-c', 'user.email=aios@local', '-c', 'user.name=AIOS', '-c', 'core.autocrlf=false',
      '-c', 'core.bare=false', // the dir is init'd bare so it holds no work tree of its own
      '-c', 'gc.auto=256'].concat(args), { cwd: ROOT }, (e) => cb && cb(e));
  }
  function ensureHistoryRepo(cb) {
    if (histReady) return cb();
    const pin = (e) => {
      // Persist in the repo's own config, so a manual `git --git-dir=.aios-history …
      // checkout` restores byte-exact instead of rewriting every line ending
      // (Git for Windows defaults core.autocrlf=true).
      execFile('git', ['--git-dir=' + HISTORY_DIR, 'config', 'core.autocrlf', 'false'], () => {
        histReady = true; cb(e);
      });
    };
    if (fs.existsSync(HISTORY_DIR)) return pin();
    execFile('git', ['init', '--bare', HISTORY_DIR], (e) => {
      if (e) { histReady = true; return cb(e); } // git missing → snapshots off, vault still works
      pin();
    });
  }
  function snapshot(why) {
    // Non-blocking, errors swallowed (git may not be installed — vault still works).
    if (!history) return;
    if (why) histRoutes.add(why);
    if (histTimer) return;
    histTimer = setTimeout(() => {
      histTimer = null;
      const msg = 'aios: ' + (Array.from(histRoutes).join(' ') || 'write');
      histRoutes.clear();
      ensureHistoryRepo(() => historyGit(['add', '-A', '-f', '.'].concat(HISTORY_EXCLUDES),
        () => historyGit(['commit', '-m', msg])));
    }, delayMs);
    if (histTimer.unref) histTimer.unref(); // never hold the process open
  }

  function read(rel) { try { return fs.readFileSync(safeJoin(rel), 'utf8'); } catch (e) { return null; } }
  function write(rel, txt, why) {
    const p = safeJoin(rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeFileAtomic(p, txt);
    snapshot(why);
  }
  function append(rel, line, why) {
    let cur = '';
    // only a missing file counts as empty: a locked one (EBUSY/EACCES) read as '' would be overwritten
    try { cur = fs.readFileSync(safeJoin(rel), 'utf8').replace(/\s*$/, ''); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    write(rel, (cur ? cur + '\n' : '') + line + '\n', why); // a new file starts on line 1, not after a blank line
  }

  return { root: ROOT, read, write, append, safeJoin, snapshot };
}

const shared = new Map();
function forRoot(root) {
  const key = path.resolve(root);
  if (!shared.has(key)) shared.set(key, createVault(key));
  return shared.get(key);
}

module.exports = { createVault, forRoot };
