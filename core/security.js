'use strict';
/* Request guards shared by core and the legacy server (moved out of system/server.js
 * unchanged). Core runs guard() before dispatching, so every module route gets these
 * checks with nothing a module could forget to opt into. */
function create(getMachine) {
  function isLoopback(req) {
    const a = req.socket.remoteAddress || '';
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  }
  function hostAllowed(req) {
    // DNS-rebinding guard: mutating requests must carry a local Host header.
    const h = (req.headers.host || '').replace(/:\d+$/, '');
    if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return true;
    if (getMachine().lanEnabled && /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // bare LAN IP, not a domain
    return false;
  }
  function sameOrigin(req) {
    // Real CSRF guard. A Host header proves nothing — the browser sends OUR host on a
    // cross-site POST too. Sec-Fetch-Site and Origin are set by the browser and cannot be
    // forged by page script. A request carrying neither is not a browser (curl, the START
    // script, a peer) and falls back to the Host + loopback/token checks.
    const site = req.headers['sec-fetch-site'];
    if (site) return site === 'same-origin' || site === 'none';
    const origin = req.headers.origin;
    if (origin) {
      let o; try { o = new URL(origin); } catch (e) { return false; }
      const m = getMachine();
      const hostOk = o.hostname === 'localhost' || o.hostname === '127.0.0.1' || o.hostname === '::1' ||
        (m.lanEnabled && /^\d{1,3}(\.\d{1,3}){3}$/.test(o.hostname));
      return o.protocol === 'http:' && hostOk && (+o.port || 80) === +m.port;
    }
    return true; // no browser fetch metadata at all
  }
  function tokenOk(req) {
    return (req.headers['x-aios-token'] || '') === (getMachine().lanToken || '');
  }
  // EventSource cannot set headers, so /api/events alone may carry the token as ?t=.
  function queryTokenOk(req, p) {
    if (p !== '/api/events') return false;
    let t = '';
    try { t = new URL(req.url || '/', 'http://x').searchParams.get('t') || ''; } catch (e) {}
    return t !== '' && t === (getMachine().lanToken || '');
  }
  const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
  function guard(req, p) {
    const api = p.startsWith('/api/');
    // Host on every API call (DNS rebinding reads too, not just writes); same-origin on
    // every method that can change something — module routes may use PUT/DELETE.
    if ((api || req.method === 'POST') && !hostAllowed(req)) return { code: 403, error: 'bad host header' };
    if (!SAFE.has(req.method) && !sameOrigin(req)) return { code: 403, error: 'cross-site request blocked' };
    // Loopback stays open so the local dashboard just works; every other client must
    // present the pairing token, or LAN mode would expose the whole vault.
    if (api && !isLoopback(req) && !(getMachine().lanToken && (tokenOk(req) || queryTokenOk(req, p))))
      return { code: 403, error: 'this vault is not open on the network — send the x-aios-token header, or open the dashboard with ?t=<token>' };
    return null;
  }
  return { isLoopback, hostAllowed, sameOrigin, tokenOk, guard };
}

module.exports = { create };
