# pi-xfer

[![npm version](https://img.shields.io/npm/v/pi-xfer.svg?style=flat-square)](https://www.npmjs.com/package/pi-xfer)
[![license](https://img.shields.io/npm/l/pi-xfer.svg?style=flat-square)](./LICENSE)

Structured markdown handoff between [pi](https://github.com/nicobailon/pi) coding agents. Instead of chat fragments, agents exchange a document — Context / Problem / Requirements / a return address — that the receiving agent can actually act on. Local Unix-socket delivery works out of the box; the **Mesh** adds opt-in cross-machine transport; the **web picker** pulls structured context straight from the browser.

## Intro Demo

**Chat Logs Are Not a Handoff — pi-xfer Sends Documents**

~76s of two real pi sessions exchanging handoffs.

**[▶ Watch on YouTube →](https://youtu.be/0mm2CirJMUo)**

## Quickstart

```bash
pi install npm:pi-xfer
pi --xfer alpha   # terminal 1
pi --xfer beta    # terminal 2
```

Then tell `alpha`:

```
/xfer beta Summarize this repo and send it back as a handoff
```

Full walkthrough in [`docs/guides/quickstart.md`](docs/guides/quickstart.md) · cross-machine setup in [`docs/guides/mesh-setup.md`](docs/guides/mesh-setup.md).

## Capabilities

| Capability | What it does |
|---|---|
| **Local transport** | Unix-socket peers at `~/.pi/xfer/<name>.sock`; `/xfer list`, zombie GC (`/xfer gc`), metadata files, install self-check (`/xfer doctor`); `/xfer broker start|status|stop|logs` daemon for the web picker |
| **Mesh transport** | Opt-in cross-machine delivery over [RivetKit](https://rivet.dev) (`/xfer mesh up/down/list`); one in-process actor per instance, engine-side discovery, durable queue, bundle + on-demand native runtime (see `docs/adr/0013`) |
| **Board** | Machine-local async collaboration cards (`/xfer board`); append-only entries, human-cleaned (see `docs/adr/0014`) |
| **Web picker** | Tampermonkey userscript + local broker: pick page elements, record interaction spans, submit as handoff (see `docs/dev/web-picker.md`) |

Install the userscript straight from the raw URL (the `.user.js` suffix triggers Tampermonkey's install prompt): <https://raw.githubusercontent.com/azzgo/pi-xfer/main/web-picker.user.js>

## Positioning

pi-xfer covers **heavy-context handoff**: structured documents, cross-machine transport, and browser capture. For lightweight same-machine notes ("check this file", quick questions), [pi-intercom](https://github.com/nicobailon/pi-intercom) is the better fit — the two coexist naturally.

## Docs

**User guides**

- [Quickstart](docs/guides/quickstart.md) — your first handoff in five minutes
- [Mesh setup](docs/guides/mesh-setup.md) — cross-machine transport with RivetKit

**Development**

- [Web picker](docs/dev/web-picker.md) — userscript + broker workflow
- [Architecture decision records](docs/adr/) — mesh transport, board scope, web-picker record philosophy
- [CONTEXT.md](CONTEXT.md) — glossary and mental model (Mesh, Node, Board, Card, Marker, …)

## Layout

- `docs/guides/` — user guides ([quickstart](docs/guides/quickstart.md), [mesh setup](docs/guides/mesh-setup.md))
- `docs/adr/` — decision records (mesh transport, board scope, web-picker record philosophy)
- `CONTEXT.md` — glossary (Mesh, Node, Board, Card, Marker, …)
- `mesh-runtime.src/` + `mesh-runtime.cjs` — bundled mesh engine, source and committed build product
- `web-picker.src/` + `web-picker.user.js` — userscript source and committed build product

pi-xfer was formerly maintained inside [azzgo/dotfiles](https://github.com/azzgo/dotfiles) (`pi/agent/extensions/xfer/`); history preserved from the initial commit.

## Development

```bash
npm install
npm test
npm run build
```

## Acknowledgements

- Design inspiration: [the video that started it](https://www.youtube.com/watch?v=PIdETjcXNIk)
- First version based on [disler/pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code)

## License

MIT
