# Xfer — unidirectional cross-project handoff extension

Generate a markdown handoff doc via a `/handoff-style` prompt, send it via Unix
socket to another Pi instance. **One-way only, no wait.** Reply by calling
`/xfer` again.

Optional `~/.pi/xfer/settings.json` adds **remote peers** (one-shot send
commands) and a **bridge listener** (expose this session over TCP through a
tunnel) — see `docs/bridging.md`. Without that file behavior is unchanged.

## Install

```bash
just install-pi    # auto symlink ~/.pi/agent/extensions/xfer → repo folder
```

## Web Picker (page side)

`web-picker.user.js` is the Tampermonkey page side of the broker: pick
elements, annotate (solo or shift-group), send handoffs, answer ask-page
questions. Install — open the raw URL in a browser with Tampermonkey enabled;
the `.user.js` suffix triggers the install prompt automatically:

<https://raw.githubusercontent.com/azzgo/dotfiles/main/pi/agent/extensions/xfer/web-picker.user.js>

Manual install, shortcuts and troubleshooting:
[`docs/web-picker.md`](docs/web-picker.md).

## Usage

| Command | Meaning |
|---------|---------|
| `/xfer` | help |
| `/xfer list` | list peers: local socks + remote (settings.json) + listener status |
| `/xfer name [<name>]` | show or set this agent's name |
| `/xfer <target> <request>` | handoff to a LOCAL peer (LLM doc + `xfer_to`) |
| `/xfer peer <name> <request>` | handoff to a REMOTE settings peer (LLM doc + `xfer_peer_to`) |
| `/xfer listener setup` | start the bridge command from `listen.bridge` |
| `/xfer listener stop` | stop the bridge + close the TCP listener |
| `/xfer listener logs` | dump recent bridge output |
| `/xfer status` | listener status summary |

### LLM tools

`xfer_to(target, summary, handoff_document)` — local peers:

1. write `/tmp/pi-xfer-<id>.md`
2. socket-notify target `{file, summary}`
3. return `handoff_id` immediately (no wait)

`xfer_peer_to(target, summary, handoff_document)` — remote settings peers:
same shape; delivers by running the peer's `send` command template
(`%msgfile`/stdin branch, exit-code result, fire-and-forget).

Reply by `/xfer <original sender> <message>` — each xfer is an independent
one-way message.

## Protocol

- Unix socket at `~/.pi/xfer/<name>.sock` (local peers, always on)
- Bridge TCP listener on `127.0.0.1:0` while `/xfer listener setup` is running
  (same frames, same ack protocol)
- Peer metadata at `~/.pi/xfer/<name>.json` (session name, cwd, model,
  status, pid, startedAt — refreshed by a 1s poll + status events)
- Message: `xfer-notify` (JSON lines, one-way; target remains the xfer name)

## Settings (optional)

`~/.pi/xfer/settings.json`: `listen.bridge` command template (`%p` = local TCP
port) + `peers.<name>.{send, timeoutMs, note}` send templates
(`%msgfile`, `%n`, `%peer`, `%%`). Interpolation of unknown `%token` or raw
`%msg` is rejected. Full schema + tailcat/nc/ssh/curl examples:
[`docs/bridging.md`](docs/bridging.md).

## Tests

```bash
npm test    # node --test, zero deps (inline .js→.ts resolve hook)
```

## Layout

| File | Responsibility |
|------|----------------|
| `index.ts` | entry wiring: flag, `xfer_to` + `xfer_peer_to` tools, status events, lifecycle |
| `controller.ts` | inbound socket lifecycle: start / rename / shutdown; bridge listener + BridgeManager ownership; shutdown reap |
| `commands.ts` | `/xfer` command (`list`, `peer`, `listener`, `status`, `name`, …) + completions |
| `settings.ts` | `~/.pi/xfer/settings.json` loader/validator + template interpolation |
| `oneshot.ts` | remote peer send: temp frame file, template spawn, stdin/msgfile branch, waitExit |
| `peers.ts` | peer registry: local socks + settings peers (separate namespaces) |
| `bridge.ts` | bridge command lifecycle: spawn, ring buffer, stop ladder |
| `state.ts` | runtime identity + `<name>.json` metadata write/poll |
| `client.ts` | outbound `sendNotify` (connect → send → wait ack) |
| `server.ts` | inbound server: unix + TCP dual-stack (parse frames, deliver, ack) |
| `utils.ts` | pure helpers: name encoding, endpoints, peer listing |
| `constants.ts` | paths + timeouts |
| `types.ts` | `PeerInfo`, `XferNotifyMessage`, `Identity`, settings types |
| `web-picker.user.js` | Tampermonkey page-side picker — see [docs/web-picker.md](docs/web-picker.md) |
