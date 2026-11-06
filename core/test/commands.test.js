'use strict';
const { createRegistry, normalize } = require('../commands.js');

module.exports = async function (ok) {
  ok('normalize strips fillers and punctuation', normalize('Viero, please open Spotify!') === 'open spotify', normalize('Viero, please open Spotify!'));
  ok('normalize folds apostrophes', normalize("What's due?") === 'whats due');
  ok('normalize of empty is empty', normalize('') === '' && normalize(null) === '');

  const r = createRegistry();
  r.register('modes', [
    { id: 'modes.switch', patterns: ['{mode} mode', 'switch to {mode}'], help: 'Switch mode' },
    { id: 'modes.open', patterns: ['open {app}'] },
    { id: 'modes.volume', patterns: ['volume {n}'] },
    { id: 'modes.openmode', patterns: ['open {mode} mode'] },
    { id: 'modes.say', patterns: ['open {thing}'] }, // free slot: competes with open {app} and open {mode} mode
    { id: 'modes.wipe', patterns: ['wipe everything'], confirm: true }
  ]);
  r.slot('modes', 'mode', () => ['focus', 'game', { value: 'relax', aliases: ['chill'] }]);
  r.slot('modes', 'app', () => [{ value: 'code', aliases: ['visual studio code', 'vs code'] }, 'spotify']);

  let m = r.match('game mode');
  ok('constrained slot matches', m && m.id === 'modes.switch' && m.args.mode === 'game', JSON.stringify(m));
  m = r.match('switch to chill');
  ok('alias resolves to its value', m && m.args.mode === 'relax', JSON.stringify(m));
  m = r.match('open visual studio code');
  ok('multi-word alias matches', m && m.id === 'modes.open' && m.args.app === 'code', JSON.stringify(m));
  ok('unknown slot value does not match', r.match('switch to sleepy') === null);
  ok('constrained slot beats a free slot', r.match('open spotify').id === 'modes.open');
  ok('free slot catches what nothing else claims', r.match('open notepad').id === 'modes.say');
  m = r.match('volume 40');
  ok('free slot captures words', m && m.id === 'modes.volume' && m.args.n === '40', JSON.stringify(m));
  ok('free slot needs at least one word', r.match('volume') === null);
  m = r.match('open game mode');
  ok('priority: more literal words wins', m && m.id === 'modes.openmode', JSON.stringify(m));
  ok('empty text matches nothing', r.match('') === null && r.match('please uh') === null);

  // tie (Review Focus 5): same words claimed by two modules → registration order
  const t = createRegistry();
  t.register('a', [{ id: 'a.x', patterns: ['do the thing'] }]);
  t.register('b', [{ id: 'b.x', patterns: ['do the thing'] }]);
  ok('tie: first registered wins, every time', t.match('do the thing').id === 'a.x');

  let res = await r.run('game mode');
  ok('run without a handler reports it', res.ok === false && /no handler/.test(res.error), JSON.stringify(res));
  r.handle('modes', 'modes.switch', (args) => ({ toast: 'now ' + args.mode }));
  res = await r.run('game mode', { source: 'test' });
  ok('run calls the handler and merges its result', res.ok === true && res.matched === true && res.command === 'modes.switch' && res.toast === 'now game', JSON.stringify(res));
  r.handle('modes', 'modes.volume', () => undefined);
  res = await r.run('volume 10');
  ok('a handler returning nothing still means ok', res.ok === true);
  r.handle('modes', 'modes.open', () => { throw new Error('not installed'); });
  res = await r.run('open spotify');
  ok('a throwing handler becomes ok:false with the message', res.ok === false && res.error === 'not installed');
  r.handle('modes', 'modes.wipe', () => ({ toast: 'wiped' }));
  res = await r.run('wipe everything');
  ok('confirm:true asks first', res.needsConfirm === true && res.ok === false);
  res = await r.run('wipe everything', { confirmed: true });
  ok('confirmed run goes through', res.ok === true && res.toast === 'wiped');

  // fuzzy matching (spec §5.4) — the matcher table of spec §10
  m = r.match('game mode');
  ok('exact match is sure with score 1', m && m.sure === true && m.score === 1 && m.text === 'game mode', JSON.stringify(m));
  m = r.match('focus mod');
  ok('one dropped letter still runs', m && m.id === 'modes.switch' && m.args.mode === 'focus' && m.sure === true, JSON.stringify(m));
  m = r.match('gay mode');
  ok('"gay mode" is a did-you-mean for game mode, not a run', m && m.id === 'modes.switch' && m.sure === false && m.text === 'game mode', JSON.stringify(m));
  m = r.match('open spot if eye');
  ok('"open spot if eye" opens spotify (split words join into one value)', m && m.id === 'modes.open' && m.args.app === 'spotify' && m.sure === true, JSON.stringify(m));
  ok('must not match: "what game should I play"', r.match('what game should I play') === null);
  ok('must not match: "tell me a joke"', r.match('tell me a joke') === null);
  m = r.match('switch to chill');
  ok('canonical text uses the value, not the alias', m && m.text === 'switch to relax', m && m.text);
  ok('more than 12 words is never a command', r.match('open ' + 'very '.repeat(12) + 'spotify') === null);
  ok('a free slot captures at most 8 words', r.match('volume 1 2 3 4 5 6 7 8 9') === null);
  res = await r.run('gay mode');
  ok('run on a did-you-mean returns the suggestion and runs nothing', res.ok === false && res.matched === false && res.suggestion && res.suggestion.text === 'game mode' && res.suggestion.command === 'modes.switch', JSON.stringify(res));
  res = await r.run('game mode');
  ok('run reports match/action times, args and phrase', res.ok === true && typeof res.ms.match === 'number' && typeof res.ms.action === 'number' && res.phrase === 'game mode' && res.args.mode === 'game', JSON.stringify(res));
  // a short value two letters off must be asked about, not run (M3 final review: "close teams" closed Steam)
  const sv = createRegistry();
  sv.register('modes', [{ id: 'modes.close', patterns: ['close {app}'] }]);
  sv.slot('modes', 'app', () => ['steam', 'discord']);
  m = sv.match('close teams');
  ok('"close teams" asks about steam instead of closing it', m && m.sure === false && m.args.app === 'steam', JSON.stringify(m));
  ok('…while "close steam" still runs', sv.match('close steam').sure === true);
  const vocab = r.vocabulary();
  ok('vocabulary lists sayable phrases incl. aliases, no slots', vocab.includes('game mode') && vocab.includes('switch to chill') && vocab.includes('open vs code') && vocab.includes('volume') && !vocab.some(v => /[{}]/.test(v)), JSON.stringify(vocab));
  // the whisper prompt is cut at 600 chars: every command must show up before alternate phrasings fill it
  ok('vocabulary lists every command\'s first pattern before alternates', vocab.indexOf('volume') >= 0 && vocab.indexOf('volume') < vocab.indexOf('switch to focus'), JSON.stringify(vocab));
  res = await r.run('make me a sandwich');
  ok('no match reports matched:false', res.ok === false && res.matched === false);

  let threw = '';
  try { r.register('modes', [{ id: 'other.x', patterns: ['x'] }]); } catch (e) { threw = e.message; }
  ok('command ids must start with the module id', /must start with "modes\."/.test(threw), threw);
  threw = '';
  try { r.register('modes', [{ id: 'modes.switch', patterns: ['y'] }]); } catch (e) { threw = e.message; }
  ok('duplicate command ids are refused', /duplicate/.test(threw), threw);
  threw = '';
  try { r.handle('other', 'modes.switch', () => {}); } catch (e) { threw = e.message; }
  ok('a module cannot handle another module\'s command', /not declared in other/.test(threw), threw);

  r.slot('modes', 'mode', () => { throw new Error('provider broke'); });
  ok('a throwing slot provider means no match, not a crash', r.match('game mode') === null);

  r.unregisterModule('modes');
  ok('unregisterModule removes commands', r.list().length === 0 && r.match('volume 5') === null);
  // call: run a declared handler by id, no matching (Viero passes long text past the 8-word slot cap)
  const k = createRegistry();
  k.register('m', [{ id: 'm.x', patterns: ['do x {text}'] }, { id: 'm.unhandled', patterns: ['nothing here'] }, { id: 'm.wipe', patterns: ['wipe it'], confirm: true }, { id: 'm.bad', patterns: ['break it'] }]);
  k.handle('m', 'm.x', (a, c) => ({ say: a.text + '/' + c.source }));
  k.handle('m', 'm.wipe', () => ({ say: 'wiped' }));
  k.handle('m', 'm.bad', () => { throw new Error('busy'); });
  res = await k.call('m.x', { text: 'a b c d e f g h i j' }, { source: 'viero' });
  ok('call runs a handler by id with args and ctx', res.ok === true && res.command === 'm.x' && res.say === 'a b c d e f g h i j/viero', JSON.stringify(res));
  const nope = await k.call('nope.y'), unh = await k.call('m.unhandled');
  ok('call on an unknown or unhandled id is missing', nope.ok === false && nope.missing === true && unh.ok === false && unh.missing === true, JSON.stringify([nope, unh]));
  res = await k.call('m.bad');
  ok('call returns a thrown error as ok:false', res.ok === false && res.error === 'busy' && !res.missing, JSON.stringify(res));
  res = await k.call('m.wipe');
  ok('call ignores confirm', res.ok === true && res.say === 'wiped', JSON.stringify(res));

};
