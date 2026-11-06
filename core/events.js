'use strict';
/* In-process event bus + Server-Sent Events fan-out to the browser shell.
 * Names are "<module>.<event>"; core's own are core.toast, core.modules, core.listening. */
function createBus() {
  const listeners = new Map(); // name -> Set<fn>
  const clients = new Set();   // open SSE responses

  function off(name, fn) { const s = listeners.get(name); if (s) s.delete(fn); }
  function on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => off(name, fn);
  }
  function emit(name, data) {
    for (const fn of Array.from(listeners.get(name) || [])) {
      try { fn(data); } catch (e) { console.error('[events] ' + name + ': ' + e.message); }
    }
    const line = 'data: ' + JSON.stringify({ name, data: data === undefined ? null : data }) + '\n\n';
    for (const res of Array.from(clients)) {
      if (res.writableEnded || res.destroyed) { clients.delete(res); continue; }
      try { res.write(line); } catch (e) { clients.delete(res); }
    }
  }
  function sse(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': ok\n\n');
    clients.add(res);
    const ping = setInterval(() => {
      if (res.writableEnded || res.destroyed) return done();
      try { res.write(': ping\n\n'); } catch (e) { done(); }
    }, 25000);
    if (ping.unref) ping.unref();
    function done() { clearInterval(ping); clients.delete(res); }
    req.on('close', done);
    res.on('close', done);
  }
  return { on, off, emit, sse, clientCount: () => clients.size };
}

module.exports = { createBus };
