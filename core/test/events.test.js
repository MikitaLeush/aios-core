'use strict';
const { EventEmitter } = require('events');
const { createBus } = require('../events.js');

function fakeRes() {
  const r = new EventEmitter();
  r.chunks = []; r.writableEnded = false; r.destroyed = false;
  r.writeHead = () => {};
  r.write = (c) => { if (r.writableEnded) throw new Error('write after end'); r.chunks.push(String(c)); return true; };
  r.end = () => { r.writableEnded = true; r.emit('close'); };
  return r;
}

module.exports = async function (ok) {
  const bus = createBus();
  let got = null;
  const off = bus.on('a.b', d => { got = d; });
  bus.emit('a.b', { x: 1 });
  ok('listener receives data', got && got.x === 1);
  off(); got = null; bus.emit('a.b', { x: 2 });
  ok('off() stops delivery', got === null);

  let second = false;
  bus.on('t', () => { throw new Error('boom'); });
  bus.on('t', () => { second = true; });
  bus.emit('t');
  ok('a throwing listener does not stop the others', second === true);

  const req = new EventEmitter(); const res = fakeRes();
  bus.sse(req, res);
  ok('sse starts with an ok comment', res.chunks[0] === ': ok\n\n');
  ok('sse client is counted', bus.clientCount() === 1);
  bus.emit('core.toast', { text: 'hi' });
  const last = res.chunks[res.chunks.length - 1];
  ok('sse forwards events as data lines', last === 'data: {"name":"core.toast","data":{"text":"hi"}}\n\n', last);

  // sse disconnect (Review Focus 4)
  req.emit('close'); res.writableEnded = true;
  let threw = false;
  try { bus.emit('core.toast', { text: 'after close' }); } catch (e) { threw = true; }
  ok('sse disconnect: emit after close does not throw', threw === false);
  ok('sse disconnect: client is dropped', bus.clientCount() === 0);

  const res2 = fakeRes(); bus.sse(new EventEmitter(), res2); res2.writableEnded = true;
  bus.emit('x');
  ok('an ended response is skipped and dropped even without a close event', bus.clientCount() === 0);
};
