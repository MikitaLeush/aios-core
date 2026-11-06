'use strict';
const path = require('path');
const { createLoader } = require('../modules.js');
const { createBus } = require('../events.js');
const { createRegistry } = require('../commands.js');

const FIX = path.join(__dirname, 'fixtures', 'modules');

function memConfig(modules) {
  const m = { modules };
  return {
    get: () => JSON.parse(JSON.stringify(m)),
    mergeModule(id, patch) {
      if (!m.modules || typeof m.modules !== 'object' || Array.isArray(m.modules)) m.modules = {};
      const cur = m.modules[id];
      m.modules[id] = Object.assign({}, cur && typeof cur === 'object' ? cur : (typeof cur === 'boolean' ? { enabled: cur } : {}), patch);
    },
    raw: () => m
  };
}
function make(modules) {
  const bus = createBus(), commands = createRegistry(), config = memConfig(modules);
  const loader = createLoader({ dirs: [FIX], root: FIX, config, bus, commands, log: () => {} });
  return { bus, commands, config, loader };
}
const byId = (loader, id) => loader.list().find(x => x.id === id);

module.exports = async function (ok) {
  globalThis.__helloStops = 0;
  const all = { hello: { enabled: true, greeting: 'yo' }, 'a-needs-hello': { enabled: true }, broken: { enabled: true }, 'wrong-core': { enabled: true } };
  const { bus, commands, config, loader } = make(all);
  loader.scan();
  await loader.loadAll();

  ok('hello loads', byId(loader, 'hello').status === 'loaded');
  ok('dependency loads after its requirement (a- sorts first)', byId(loader, 'a-needs-hello').status === 'loaded');
  const b = byId(loader, 'broken');
  ok('a failing init marks the module failed with its error', b.status === 'failed' && b.error === 'boom on purpose', JSON.stringify(b));
  ok('a failed module leaves no commands behind', !commands.list().some(c => c.module === 'broken'));
  ok('core version mismatch is incompatible', byId(loader, 'wrong-core').status === 'incompatible');
  ok('enabledByDefault:true loads without config', byId(loader, 'sticky').status === 'loaded');

  // invalid folders (Review Focus 2)
  ok('invalid folders: no module.json → invalid with reason', byId(loader, 'no-manifest').status === 'invalid' && /module\.json/.test(byId(loader, 'no-manifest').error));
  ok('invalid folders: id/folder mismatch → invalid with reason', byId(loader, 'bad-id').status === 'invalid' && /must match folder/.test(byId(loader, 'bad-id').error));

  ok('module route is mounted under /api/m/<id>/', !!loader.route('GET', '/api/m/hello/ping'));
  ok('unknown route is null', loader.route('GET', '/api/m/hello/nope') === null && loader.route('POST', '/api/m/hello/ping') === null);
  const res = await commands.run('greet everyone');
  ok('command + slot alias + machine settings over defaults', res.ok && res.toast === 'yo world', JSON.stringify(res));
  let pong = null; bus.on('hello.pong', d => { pong = d; });
  bus.emit('test.ping', 7);
  ok('module events are namespaced <id>.<event>', pong === 7);

  // staticFile (Review Focus 3)
  ok('staticFile serves the declared panel', loader.staticFile('hello', 'panel.js') === path.join(FIX, 'hello', 'panel.js'));
  ok('staticFile serves assets/', loader.staticFile('hello', 'assets/hi.txt') === path.join(FIX, 'hello', 'assets', 'hi.txt'));
  ok('staticFile refuses server code', loader.staticFile('hello', 'server.js') === null);
  ok('staticFile refuses climbing out of assets/', loader.staticFile('hello', 'assets/../module.json') === null && loader.staticFile('hello', 'assets/..\\module.json') === null);
  ok('staticFile refuses failed modules', loader.staticFile('broken', 'panel.js') === null);

  // disable → dependents go down, everything is cleaned up
  let r = await loader.setEnabled('hello', false);
  ok('disable returns restartRequired:false', r.restartRequired === false);
  ok('disabled module is off', byId(loader, 'hello').status === 'off' && byId(loader, 'hello').enabled === false);
  ok('its dependent fails with a reason naming it', byId(loader, 'a-needs-hello').status === 'failed' && /hello/.test(byId(loader, 'a-needs-hello').error));
  ok('its route is gone', loader.route('GET', '/api/m/hello/ping') === null);
  ok('its commands are gone', commands.match('greet world') === null);
  ok('its stop() ran', globalThis.__helloStops === 1);
  pong = null; bus.emit('test.ping', 8);
  ok('its event listeners are gone', pong === null);
  ok('the switch was written to machine config', config.raw().modules.hello.enabled === false && config.raw().modules.hello.greeting === 'yo');

  r = await loader.setEnabled('hello', true);
  ok('re-enable loads it again', byId(loader, 'hello').status === 'loaded');
  ok('re-enable retries enabled dependents', byId(loader, 'a-needs-hello').status === 'loaded');
  ok('loadedAt is set (panel cache-busting)', typeof byId(loader, 'hello').loadedAt === 'number');

  r = await loader.setEnabled('sticky', false);
  ok('liveToggle:false asks for a restart and stays loaded', r.restartRequired === true && byId(loader, 'sticky').status === 'loaded');

  let threw = null;
  try { await loader.setEnabled('nope', true); } catch (e) { threw = e; }
  ok('unknown id throws with status 404', threw && threw.status === 404);

  await loader.stopAll();
  ok('stopAll runs stop()', globalThis.__helloStops === 2);

  // Final review #2: turning off the bottom of a chain takes down every module above it.
  {
    const x = make({ 'chain-a': true, 'chain-b': true, 'chain-c': true });
    x.loader.scan(); await x.loader.loadAll();
    ok('chain: all three load', ['chain-a', 'chain-b', 'chain-c'].every(id => byId(x.loader, id).status === 'loaded'));
    await x.loader.setEnabled('chain-c', false);
    ok('chain: direct dependent fails', byId(x.loader, 'chain-b').status === 'failed');
    ok('chain: indirect dependent fails too', byId(x.loader, 'chain-a').status === 'failed', byId(x.loader, 'chain-a').status);
    ok('chain: indirect dependent\'s route is gone', x.loader.route('GET', '/api/m/chain-a/ok') === null);
    await x.loader.setEnabled('chain-c', true);
    ok('chain: re-enabling the bottom brings the whole chain back', ['chain-a', 'chain-b', 'chain-c'].every(id => byId(x.loader, id).status === 'loaded'),
      ['chain-a', 'chain-b', 'chain-c'].map(id => id + ':' + byId(x.loader, id).status).join(' '));
    await x.loader.stopAll();
  }

  // config shapes (Review Focus 1)
  for (const [label, mods] of [['string', 'yes'], ['array', []], ['boolean entry', { hello: true }], ['missing', undefined]]) {
    const x = make(mods);
    let err = null;
    try { x.loader.scan(); await x.loader.loadAll(); } catch (e) { err = e; }
    const want = label === 'boolean entry' ? 'loaded' : 'off';
    ok('config shapes: modules=' + label + ' → no crash, hello ' + want, !err && byId(x.loader, 'hello').status === want, err ? err.message : byId(x.loader, 'hello').status);
    await x.loader.stopAll();
  }

  // module pages (M4: /status)
  {
    const t = make({ hello: { enabled: true } });
    t.loader.scan();
    await t.loader.loadAll();
    ok('a loaded module serves its page from its assets', /assets[\\/]page\.html$/.test(t.loader.page('/hello-page') || ''), t.loader.page('/hello-page'));
    ok('an unknown page path is null', t.loader.page('/nope') === null);
    await t.loader.setEnabled('hello', false);
    ok('a module that is off has no page', t.loader.page('/hello-page') === null);
  }
  // core.vault (M6a)
  {
    const sentinel = { vault: true };
    const bus = createBus(), commands = createRegistry();
    const loader = createLoader({ dirs: [FIX], root: FIX, config: memConfig({ hello: { enabled: true } }), bus, commands, vault: sentinel, log: () => {} });
    loader.scan();
    await loader.loadAll();
    ok("core.vault is the loader's opts.vault", globalThis.__helloVault === sentinel);
  }
};
