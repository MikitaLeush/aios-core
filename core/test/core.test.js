#!/usr/bin/env node
/* Core unit tests. Run alone: `node core/test/core.test.js`. system/selftest.js runs them too. */
'use strict';
const fs = require('fs');
const path = require('path');

const FILES = ['security', 'events', 'commands', 'modules', 'install', 'machine', 'publish', 'vault'];
const MODULES = path.join(__dirname, '..', '..', 'modules');

// Every module may ship modules/<id>/test/*.test.js exporting async function (ok).
function moduleTestFiles() {
  const out = [];
  let ids = [];
  try { ids = fs.readdirSync(MODULES).sort(); } catch (e) {}
  for (const id of ids) {
    let files = [];
    try { files = fs.readdirSync(path.join(MODULES, id, 'test')).filter(f => f.endsWith('.test.js')).sort(); } catch (e) { continue; }
    for (const f of files) out.push({ name: id + '/' + f.slice(0, -'.test.js'.length), file: path.join(MODULES, id, 'test', f) });
  }
  return out;
}

async function run(t) {
  for (const f of FILES) {
    t.section('core — ' + f);
    await require(path.join(__dirname, f + '.test.js'))(t.ok);
  }
  for (const m of moduleTestFiles()) {
    t.section('module — ' + m.name);
    await require(m.file)(t.ok);
  }
}

module.exports = { run };

if (require.main === module) {
  let pass = 0, fail = 0;
  const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
  };
  run({ ok, section: t => console.log('\n' + t) })
    .catch(e => { fail++; console.log('  FAIL threw — ' + e.stack); })
    .then(() => { console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); });
}
