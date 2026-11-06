'use strict';
module.exports = { init(core) { core.route('GET', 'ok', (req, res) => { res.writeHead(200); res.end('ok'); }); } };
