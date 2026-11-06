# How AIOS is built

AIOS is a small **core** (`core/`) plus **modules** (`modules/<id>/`) you switch on or off per
machine. Core serves the shell at `http://localhost:4321`, loads the modules that are on, and
gives them one command registry, one event bus and one settings file. Everything listens on
127.0.0.1 only.

## Per-machine settings — `system/machine.json`

Not in the repo (each computer has its own). A module missing from `modules` is off.

```json
{ "port": 4321, "modules": { "modes": { "enabled": true, "apps": {}, "modes": {} } } }
```

The Modules screen turns modules on and off live and writes `enabled` here.

## A module

```
modules/<id>/
  module.json      manifest (required)
  server.js        runs in the core process (optional)
  commands.json    phrases for the palette (Ctrl+K) and voice (optional)
  panel.js         browser ES module for the shell (optional)
  assets/          files served at /m/<id>/assets/… (optional)
  test/*.test.js   run by node core/test/core.test.js
```

### `module.json`

| Key | Meaning |
|---|---|
| `id`, `name`, `version`, `description` | identity; `id` is `[a-z][a-z0-9-]*` |
| `core` | core contract version it was written for (1); a mismatch is not loaded |
| `requires` | other module ids; loaded first, and a missing one disables this module with a reason |
| `touches` | plain words shown before install ("closes apps"). Informational: Node cannot sandbox a module |
| `server`, `panel`, `overlay`, `commands` | file names, all optional |
| `page` | `{ "path": "/status", "file": "assets/fullscreen.html" }` — one top-level page |
| `defaults` | default settings, merged under this machine's settings |
| `enabledByDefault`, `liveToggle` | on without a machine.json entry / `false` = toggling needs a restart |
| `public` | `true` = included when the repo is published (`core/publish.js`); modules without it stay private |

### `server.js`

```js
module.exports = {
  async init(core) { /* routes, command handlers, listeners */ },
  async stop() { /* kill child processes, clear timers */ }
};
```

| `core.` | Does |
|---|---|
| `id`, `dir`, `root` | module id, module folder, repo root |
| `route(method, sub, handler)` | mounts `/api/m/<id>/<sub>`; `handler(req, res, body)`; core's security checks always apply |
| `config()` / `setConfig(patch)` | this machine's settings over `defaults` / save a patch to machine.json |
| `events.on(name, fn)` / `events.emit(name, data)` | events are named `<id>.<name>` and also reach browsers over SSE |
| `commands.handle(id, fn)` | handler for a command in `commands.json`; returns `{ ok?, say?, toast?, level?, details? }` |
| `commands.slot(name, fn)` | the values a `{name}` slot can take, e.g. mode names |
| `commands.run(text)` | match + run, the same path the palette and voice use |
| `notify(text, level)` / `log(...)` | toast in the shell / prefixed server log |

`init` throwing marks the module **failed** with its error; its routes and commands are removed and
core keeps running. A route that throws answers 500 naming the module.

### `commands.json`

```json
[{ "id": "modes.switch", "patterns": ["{mode} mode", "switch to {mode}"], "help": "Switch to a mode" }]
```

`confirm: true` makes every caller ask first. Matching is fuzzy within limits: a near miss is
offered as "did you mean …?", never run unasked.

### `panel.js`

```js
export function mount(el, ctx) { /* draw into el */ return { unmount() {} }; }
```

`ctx.api(sub, { body })` calls the module's routes, `ctx.on(event, fn)` listens to events,
`ctx.run(text)` runs a command, `ctx.notify(text, level)` shows a toast. Panels use the shared
classes in `shell/design/theme.css`.

## Core routes

| Route | Does |
|---|---|
| `GET /api/core/modules` | every module with its status and reason |
| `POST /api/core/modules/toggle` `{id, enabled}` | load or unload now, saved to machine.json |
| `POST /api/core/modules/inspect` `{url}` / `install` | git clone to a temp folder and show its manifest; install puts it in `modules/` **disabled** |
| `POST /api/core/run` `{text}` | match + run a command |
| `GET /api/events` | server-sent events |

## Security

- Loopback only by default. With LAN mode on, every `/api/` call from another computer needs the token.
- Cross-site requests and foreign `Host` headers are refused on every `/api/` route.
- Secrets (the calendar link, the LAN token) live only in `system/machine.json`.
- A third-party module is installed off; read its `touches` and code before turning it on.
