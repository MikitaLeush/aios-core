# AIOS

A small local core for Windows that you extend with **modules** you switch on and off per
computer. This repo is the core only — it ships with no modules. Get the ones you want from
[aios-modules](https://github.com/MikitaLeush/aios-modules):

- **Viero** — push-to-talk voice commands, speech-to-text on your own computer (faster-whisper).
  Hold a key, say `game mode`, let go.
- **Modes** — one command for focus / game / relax: close apps, set the audio device and volume,
  launch a PowerToys Workspace, open apps.
- **Status** — the date, what's due, the weather (Open-Meteo, no key) and your calendar (iCal), as a
  panel and as a full-screen `/status` page for a TV.
- **Tasks** and **Terminal** — a task list, and a shell plus Claude Code in the dashboard.

Voice, the Ctrl+K palette and the modules all go through one command registry, so the same words
do the same thing everywhere. Everything runs on 127.0.0.1. No accounts, no cloud, no `npm install`.

![Viero latency](docs/latency.svg)

*Measured by `node modules/viero/bench.js`. Each group names the speech model and the clip set:
`aios-viero-clips` = synthetic text-to-speech voices, `real` = a real microphone.*

## Requirements

- Windows 10 or 11 and Node.js 22 or newer.
- Viero only: Python 3.10+.
- Modes audio steps only: the AudioDeviceCmdlets PowerShell module.
- Modes workspaces only: PowerToys Workspaces.

## Quick start

1. Clone this repository and open a terminal in its folder.
2. `node core/server.js`, then open http://localhost:4321. It runs, with nothing in it yet.
3. Open **Modules** and install Modes from
   `https://github.com/MikitaLeush/aios-modules.git#modes` (or copy the `modes` folder from
   aios-modules into `modules/`).
4. Stop AIOS and create `system/machine.json` with:

<!-- quickstart-config -->
```json
{
  "modules": {
    "modes": {
      "enabled": true,
      "dryRun": true,
      "apps": {
        "spotify": { "launch": "spotify:", "process": "Spotify.exe", "aliases": ["music"] },
        "discord": { "launch": "discord://", "process": "Discord.exe" }
      },
      "modes": {
        "focus": { "close": ["discord"], "audio": { "volume": 30 } },
        "relax": { "open": ["spotify"], "audio": { "volume": 25 } }
      }
    }
  }
}
```

5. Start AIOS again (`node core/server.js`).
6. Press **Ctrl+K** and type `focus mode`. With `"dryRun": true` AIOS lists the steps it would take
   and changes nothing; set it to `false` when the steps look right.

Every module has a README with its full settings in
[aios-modules](https://github.com/MikitaLeush/aios-modules). Turn modules on and off on the
**Modules** screen.

## How it works

[docs/architecture.md](docs/architecture.md): the module contract, core routes and security.
Writing a module is a folder with a `module.json`.

## Tests

```
node core/test/core.test.js
```

Runs core's tests and the `test/*.test.js` of every module you have installed. Viero's listener
checks are skipped until its Python setup exists.

## Privacy

- Audio is held in memory only while the key is down and is never written to disk.
- The calendar link and the LAN token live only in `system/machine.json`, which is not in the repo.
- Weather requests send only the latitude and longitude you set.

## License

MIT, see [LICENSE](LICENSE).
