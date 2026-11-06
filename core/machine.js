'use strict';
/* Per-machine config (system/machine.json): never synced, never published. Read fresh on
 * every call (it is tiny) and written by merging into what is on disk, so hand-edits and
 * the legacy server's own writes survive. AIOS_MACHINE_FILE points tests at a scratch copy. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = process.env.AIOS_MACHINE_FILE || path.join(ROOT, 'system', 'machine.json');

function readDisk() {
  try { const m = JSON.parse(fs.readFileSync(FILE, 'utf8')); return m && typeof m === 'object' ? m : {}; }
  catch (e) { return {}; }
}

function get() {
  const m = Object.assign({ port: 4321, lanEnabled: false, lanToken: '', machineName: os.hostname() }, readDisk());
  if (/^\d+$/.test(process.env.AIOS_PORT || '')) m.port = +process.env.AIOS_PORT;
  return m;
}

function mergeModule(id, patch) {
  // Writing over a file we could not parse would erase it (no undo: never in .aios-history),
  // so only a missing file counts as empty here.
  let disk = {};
  try { disk = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('system/machine.json is unreadable (' + e.message + ') — fix it by hand; nothing was saved'); }
  if (!disk || typeof disk !== 'object' || Array.isArray(disk)) throw new Error('system/machine.json is not a JSON object — fix it by hand; nothing was saved');
  const mods = disk.modules && typeof disk.modules === 'object' && !Array.isArray(disk.modules) ? disk.modules : {};
  const cur = mods[id];
  const base = cur && typeof cur === 'object' ? cur : (typeof cur === 'boolean' ? { enabled: cur } : {});
  mods[id] = Object.assign({}, base, patch);
  disk.modules = mods;
  fs.mkdirSync(path.dirname(FILE), { recursive: true }); // a fresh clone has no system/ folder yet
  const tmp = FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(disk, null, 2));
  fs.renameSync(tmp, FILE);
}

module.exports = { ROOT, FILE, get, mergeModule };
