# pi-xfer

Cross-context handoff for [pi](https://github.com/nicobailon/pi) coding agents — from `📨 [Xfer from **peer**]` messages to structured handoff documents. Agents exchange markdown handoffs (Context / Problem / Requirements / Return address), not chat fragments.

## Quickstart

```bash
pi install npm:pi-xfer
```

Then run `pi` in two terminals and tell one agent: *"Send a handoff to the other session asking it to summarize this repo."* That's the whole loop — full walkthrough in [`docs/guides/quickstart.md`](docs/guides/quickstart.md).

Formerly maintained inside [azzgo/dotfiles](https://github.com/azzgo/dotfiles) (`pi/agent/extensions/xfer/`); history preserved from the initial commit.

## Install

```bash
pi install npm:pi-xfer
```

Or from GitHub:

```bash
pi install git+https://github.com/azzgo/pi-xfer
```

## Web picker userscript

Install the Tampermonkey userscript straight from the raw URL (the `.user.js`
suffix triggers Tampermonkey's install prompt):

<https://raw.githubusercontent.com/azzgo/pi-xfer/main/web-picker.user.js>

## Positioning

pi-xfer covers **heavy-context handoff**: structured documents, cross-machine transport, and browser capture. For lightweight same-machine notes ("check this file", quick questions), [pi-intercom](https://github.com/nicobailon/pi-intercom) is the better fit — the two coexist naturally.

## Capabilities

| Capability | What it does |
|---|---|
| **Local transport** | Unix-socket peers at `~/.pi/xfer/<name>.sock`; `/xfer list`, zombie GC (`/xfer gc`), metadata files, install self-check (`/xfer doctor`); `/xfer broker start|status|stop|logs` daemon for the web picker |
| **Mesh transport** | Opt-in cross-machine delivery over [RivetKit](https://rivet.dev) (`/xfer mesh up/down/list`); one in-process actor per instance, engine-side discovery, durable queue, bundle + on-demand native runtime (see `docs/adr/0013`) |
| **Board** | Machine-local async collaboration cards (`/xfer board`); append-only entries, human-cleaned (see `docs/adr/0014`) |
| **Web picker** | Tampermonkey userscript + local broker: pick page elements, record interaction spans, submit as handoff (see `docs/dev/web-picker.md`) |

## Layout

- `docs/guides/` — user guides ([quickstart](docs/guides/quickstart.md), [mesh setup](docs/guides/mesh-setup.md))
- `docs/adr/` — decision records (mesh transport, board scope, web-picker record philosophy)
- `CONTEXT.md` — glossary (Mesh, Node, Board, Card, Marker, …)
- `mesh-runtime.src/` + `mesh-runtime.cjs` — bundled mesh engine, source and committed build product
- `web-picker.src/` + `web-picker.user.js` — userscript source and committed build product

## Development

```bash
npm install
npm test
npm run build
```

## License

MIT
