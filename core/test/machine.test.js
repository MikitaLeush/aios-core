'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// machine.js binds its file path at require time, so each case runs in a child process.
function merge(file) {
  const code = "try { require(process.argv[1]).mergeModule('modes', { current: 'game' }); console.log('wrote'); } catch (e) { console.log('threw ' + e.message); }";
  return execFileSync(process.execPath, ['-e', code, path.join(__dirname, '..', 'machine.js')],
    { env: Object.assign({}, process.env, { AIOS_MACHINE_FILE: file }), encoding: 'utf8' }).trim();
}

module.exports = async function (ok) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-machine-'));
  const file = path.join(dir, 'machine.json');

  const broken = '{ "port": 4400, "lanToken": "keep-me", }';
  fs.writeFileSync(file, broken);
  const r = merge(file);
  ok('mergeModule refuses to write over a machine.json it cannot parse', /^threw .*machine\.json/.test(r), r);
  ok('the unparseable file is left exactly as it was', fs.readFileSync(file, 'utf8') === broken);

  fs.unlinkSync(file);
  ok('a missing machine.json is created', merge(file) === 'wrote' && JSON.parse(fs.readFileSync(file, 'utf8')).modules.modes.current === 'game');

  fs.writeFileSync(file, JSON.stringify({ port: 4400, modules: { modes: { enabled: true } } }));
  merge(file);
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok('a good file keeps its other keys', m.port === 4400 && m.modules.modes.enabled === true && m.modules.modes.current === 'game');

  // M7: a fresh clone has no system/ folder yet
  const fresh = path.join(dir, 'no-such-folder', 'machine.json');
  const fr = merge(fresh);
  ok('a fresh clone with no system/ folder can save a setting', fr === 'wrote' && JSON.parse(fs.readFileSync(fresh, 'utf8')).modules.modes.current === 'game', fr);

  fs.rmSync(dir, { recursive: true, force: true });
};
