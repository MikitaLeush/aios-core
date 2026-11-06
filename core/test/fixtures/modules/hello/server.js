'use strict';
module.exports = {
  init(core) {
    globalThis.__helloVault = core.vault;
    core.route('GET', 'ping', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pong: core.id, greeting: core.config().greeting }));
    });
    core.commands.slot('name', () => [{ value: 'world', aliases: ['everyone'] }, 'friend']);
    core.commands.handle('hello.greet', (args) => ({ toast: core.config().greeting + ' ' + args.name }));
    core.events.on('test.ping', (d) => core.events.emit('pong', d));
  },
  stop() { globalThis.__helloStops = (globalThis.__helloStops || 0) + 1; }
};
