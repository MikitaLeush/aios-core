'use strict';
const { create } = require('../security.js');

function req(o) {
  // Real HTTP/1.1 requests always carry Host; default to the local one.
  return { method: o.method || 'GET', url: o.url || '/', headers: Object.assign({ host: 'localhost:4321' }, o.headers || {}), socket: { remoteAddress: o.ip || '127.0.0.1' } };
}

module.exports = async function (ok) {
  const m = { port: 4321, lanEnabled: false, lanToken: '' };
  const s = create(() => m);

  ok('loopback GET /api/state passes', s.guard(req({}), '/api/state') === null);
  const lan = s.guard(req({ ip: '192.168.1.5' }), '/api/state');
  ok('LAN GET /api/state without token is refused', lan && lan.code === 403);
  ok('LAN with empty token on both sides is still refused',
    s.guard(req({ ip: '192.168.1.5', headers: { 'x-aios-token': '' } }), '/api/state') !== null);
  m.lanToken = 'abc';
  ok('LAN with the right token passes', s.guard(req({ ip: '192.168.1.5', headers: { 'x-aios-token': 'abc' } }), '/api/state') === null);
  ok('LAN with a wrong token is refused', s.guard(req({ ip: '192.168.1.5', headers: { 'x-aios-token': 'nope' } }), '/api/state') !== null);
  ok('LAN GET of a non-API page passes (static files)', s.guard(req({ ip: '192.168.1.5' }), '/shell/app.js') === null);

  const evil = s.guard(req({ method: 'POST', headers: { host: 'evil.example' } }), '/api/core/run');
  ok('POST with a foreign Host is refused', evil && evil.error === 'bad host header');
  const xs = s.guard(req({ method: 'POST', headers: { host: 'localhost:4321', 'sec-fetch-site': 'cross-site' } }), '/api/core/run');
  ok('cross-site POST is refused', xs && xs.error === 'cross-site request blocked');
  ok('same-origin POST passes', s.guard(req({ method: 'POST', headers: { host: 'localhost:4321', 'sec-fetch-site': 'same-origin' } }), '/api/core/run') === null);
  ok('POST with Origin on our port passes', s.guard(req({ method: 'POST', headers: { host: 'localhost:4321', origin: 'http://localhost:4321' } }), '/api/core/run') === null);
  ok('POST with Origin on another port is refused', s.guard(req({ method: 'POST', headers: { host: 'localhost:4321', origin: 'http://localhost:9999' } }), '/api/core/run') !== null);
  ok('non-browser POST (no fetch metadata) passes the CSRF check', s.guard(req({ method: 'POST', headers: { host: '127.0.0.1:4321' } }), '/api/core/run') === null);

  // Final review #4: Host + same-origin must cover every method a module route can use.
  const rebind = s.guard(req({ headers: { host: 'evil.example' } }), '/api/state');
  ok('GET /api/* with a foreign Host is refused (DNS rebinding)', rebind && rebind.error === 'bad host header', JSON.stringify(rebind));
  const put = s.guard(req({ method: 'PUT', headers: { host: 'localhost:4321', 'sec-fetch-site': 'cross-site' } }), '/api/m/x/y');
  ok('cross-site PUT to a module route is refused', put && put.error === 'cross-site request blocked', JSON.stringify(put));
  const del = s.guard(req({ method: 'DELETE', headers: { host: 'evil.example' } }), '/api/m/x/y');
  ok('DELETE with a foreign Host is refused', del && del.error === 'bad host header', JSON.stringify(del));
  ok('same-origin GET still passes', s.guard(req({ headers: { 'sec-fetch-site': 'same-origin' } }), '/api/core/modules') === null);
  ok('a GET page load from another site is not blocked by the CSRF check', s.guard(req({ headers: { 'sec-fetch-site': 'cross-site' } }), '/') === null);

  // Final review #3: EventSource cannot send headers, so the LAN token may ride in ?t= on /api/events only.
  m.lanEnabled = true; m.lanToken = 'abc';
  ok('LAN /api/events with ?t=<token> passes', s.guard(req({ ip: '192.168.1.5', url: '/api/events?t=abc', headers: { host: '192.168.1.2:4321' } }), '/api/events') === null);
  ok('LAN /api/events with a wrong ?t= is refused', s.guard(req({ ip: '192.168.1.5', url: '/api/events?t=nope', headers: { host: '192.168.1.2:4321' } }), '/api/events') !== null);
  ok('?t= is not accepted on other API routes', s.guard(req({ ip: '192.168.1.5', url: '/api/state?t=abc', headers: { host: '192.168.1.2:4321' } }), '/api/state') !== null);
};
