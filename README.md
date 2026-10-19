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
| **Mesh transport** | Opt-in cross-machine delivery over [RivetKit](https://rivet.dev) (`/xfer mesh status/up/down/list`, with a per-node delivery verdict and a pre-send check); one in-process actor per instance, engine-side discovery, durable queue, bundle + on-demand native runtime (see `docs/adr/0013`) |
| **Node descriptions** | Self-declared capability note per mesh node (`/xfer desc <text>`, no text clears); stored on the node's actor, read per node and attached to the broker's `targets` listing so a picker user can pick by fit. Unverified self-declaration — routing stays with the consumer |
| **Board** | Machine-local async collaboration cards (`/xfer board`); append-only entries, human-cleaned (see `docs/adr/0014`) |
| **Web picker** | Tampermonkey userscript + local broker: pick page elements, record interaction spans, submit as handoff (see `docs/dev/web-picker.md`) |

Install the userscript straight from the raw URL (the `.user.js` suffix triggers Tampermonkey's install prompt): <https://raw.githubusercontent.com/azzgo/pi-xfer/main/web-picker.user.js>

## Positioning

pi-xfer covers **heavy-context handoff**: structured documents, cross-machine transport, and browser capture. For lightweight same-machine notes ("check this file", quick questions), [pi-intercom](https://github.com/nicobailon/pi-intercom) is the better fit — the two coexist naturally.

## Docs

**User guides**

- [Quickstart](docs/guides/quickstart.md) — your first handoff in five minutes
- [Mesh setup](docs/guides/mesh-setup.md) — cross-machine transport with RivetKit
- [Agent host setup](docs/guides/agent-host-setup.md) — wiring a non-pi bot (adapter daemon, Feishu notes)
- [Pi Durable agent](docs/guides/pi-durable-agent.md) — a mesh node on Cloudflare that exists only while there is work

**Development**

- [Web picker](docs/dev/web-picker.md) — userscript + broker workflow
- [Architecture decision records](docs/adr/) — mesh transport, board scope, web-picker record philosophy
- [CONTEXT.md](CONTEXT.md) — glossary and mental model (Mesh, Node, Board, Card, Marker, …)

## Layout

- `docs/guides/` — user guides ([quickstart](docs/guides/quickstart.md), [mesh setup](docs/guides/mesh-setup.md), [agent host setup](docs/guides/agent-host-setup.md), [pi durable agent](docs/guides/pi-durable-agent.md))
- `docs/adr/` — decision records (mesh transport, board scope, web-picker record philosophy)
- `CONTEXT.md` — glossary (Mesh, Node, Board, Card, Marker, …)
- `mesh-runtime.src/` + `mesh-runtime.cjs` — bundled mesh engine, source and committed build product
- `web-picker.src/` + `web-picker.user.js` — userscript source and committed build product
- `broker-main.ts` + `broker.cjs`, `admin-main.ts` + `admin.cjs` — the two daemons, source and committed build products (`npm run build` produces all four)

pi-xfer was formerly maintained inside [azzgo/dotfiles](https://github.com/azzgo/dotfiles) (`pi/agent/extensions/xfer/`); history preserved from the initial commit.

## Development

```bash
npm install
npm test
npm run build
```

To run the working tree instead of the installed `npm:pi-xfer` copy, start pi
with `pi -ne -e ./` — `-ne` skips extension discovery so the installed copy
cannot load beside this one and collide on `xfer_to` / `xfer_mesh_to` / `--xfer`.

The committed bundles (`broker.cjs`, `admin.cjs`, `mesh-runtime.cjs`, `web-picker.user.js`) are built with esbuild targeting **Node 20+**; the extension host runs on whatever Node pi requires (`engines: >=22`). `npm test` fails if a committed bundle is stale — run `npm run build` and commit the artifacts.

Contributions and host presets: see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Acknowledgements

- Design inspiration: [the video that started it](https://www.youtube.com/watch?v=PIdETjcXNIk)
- First version based on [disler/pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code)

## License

MIT
