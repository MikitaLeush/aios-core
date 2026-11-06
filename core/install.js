'use strict';
/* Third-party modules from a git URL (spec §4.6): inspect (clone to temp, read
 * module.json, run nothing) → explicit confirm → move into modules/<id>, installed OFF.
 * `touches` is shown to the user but cannot be enforced — Node has no sandbox. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

function validUrl(u) {
  return typeof u === 'string' && /^(https:\/\/[^\s]+|git@[^\s:]+:[^\s]+)$/.test(u);
}
function gitErr(e, se) { return new Error(String(se || e.message).trim().slice(0, 300)); }
function gitClone(url, dest, cb) {
  // `--` ends git's options, so a URL can never be read as one.
  execFile('git', ['clone', '--depth', '1', '--', url, dest], { timeout: 120000, windowsHide: true },
    (e, so, se) => cb(e ? gitErr(e, se) : null));
}
function gitPull(dir, cb) {
  execFile('git', ['-C', dir, 'pull', '--ff-only'], { timeout: 120000, windowsHide: true },
    (e, so, se) => cb(e ? gitErr(e, se) : null, String(so || '').trim()));
}
function rm(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
function moveDir(a, b) {
  try { fs.renameSync(a, b); }
  catch (e) {
    if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e; // temp may sit on another drive
    fs.cpSync(a, b, { recursive: true }); rm(a);
  }
}

function createInstaller(opts) {
  const clone = opts.clone || gitClone;
  const pull = opts.pull || gitPull;
  const tmpRoot = opts.tmpRoot || os.tmpdir();
  const pending = new Map(); // url -> { dir, manifest }

  // `<repo>#<folder>` takes one module out of a repo that holds several (the public aios-modules repo)
  function inspect(url) {
    return new Promise((resolve, reject) => {
      if (!validUrl(url)) return reject(Object.assign(new Error('only https:// or git@ URLs'), { status: 400 }));
      const hash = url.indexOf('#');
      const repo = hash < 0 ? url : url.slice(0, hash), sub = hash < 0 ? '' : url.slice(hash + 1);
      if (sub && !ID_RE.test(sub)) return reject(Object.assign(new Error('after # comes a module folder name, like #modes'), { status: 400 }));
      const dest = path.join(tmpRoot, 'aios-mod-' + crypto.randomBytes(6).toString('hex'));
      clone(repo, dest, (e) => {
        if (e) { rm(dest); return reject(e); }
        const dir = sub ? path.join(dest, sub) : dest;
        let m;
        try { m = JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8')); }
        catch (err) { rm(dest); return reject(Object.assign(new Error(sub ? 'no valid module.json in ' + sub + '/' : 'no valid module.json at the repo root'), { status: 400 })); }
        if (!m || !ID_RE.test(m.id || '')) { rm(dest); return reject(Object.assign(new Error('module.json id is missing or invalid'), { status: 400 })); }
        const old = pending.get(url);
        if (old) rm(old.tmp);
        pending.set(url, { dir, tmp: dest, manifest: m });
        resolve({ manifest: m, exists: fs.existsSync(path.join(opts.modulesDir, m.id)) });
      });
    });
  }

  function install(url) {
    const p = pending.get(url);
    if (!p) throw Object.assign(new Error('inspect this URL first'), { status: 400 });
    pending.delete(url);
    const target = path.join(opts.modulesDir, p.manifest.id);
    if (fs.existsSync(target)) { rm(p.tmp); throw Object.assign(new Error('modules/' + p.manifest.id + ' already exists'), { status: 409 }); }
    fs.mkdirSync(opts.modulesDir, { recursive: true }); // the base package ships with no modules/ folder
    // shortcut: a #folder install leaves the repo's .git behind, so Update can't pull it; reinstall to update
    moveDir(p.dir, target);
    if (p.dir !== p.tmp) rm(p.tmp);
    // marks the module as third-party (publish never ships it); unlike .git it syncs between computers
    fs.writeFileSync(path.join(target, '.aios-source'), url + '\n');
    return { id: p.manifest.id };
  }

  function update(id) {
    return new Promise((resolve, reject) => {
      const dir = path.join(opts.modulesDir, String(id));
      if (!ID_RE.test(String(id)) || !fs.existsSync(path.join(dir, '.git')))
        return reject(Object.assign(new Error(id + ' was not installed from git'), { status: 400 }));
      pull(dir, (e, out) => e ? reject(e) : resolve(out));
    });
  }

  return { inspect, install, update };
}

module.exports = { createInstaller, validUrl };
