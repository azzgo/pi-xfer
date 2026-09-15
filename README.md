# Xfer — unidirectional cross-project handoff extension

Generate a markdown handoff doc via a `/handoff-style` prompt, send it via Unix
socket to another Pi instance. **One-way only, no wait.** Reply by calling
`/xfer` again.

## Install

```bash
just install-pi    # auto symlink ~/.pi/agent/extensions/xfer → repo folder
```

## Web Picker (page side)

`web-picker.user.js` is the Tampermonkey page side of the broker: pick
elements, annotate (solo or shift-group), send handoffs, and answer the
agent's page-tool queries (fixed op table — no eval, no modal). Since
v1.12: per-origin auto-reconnect after the first manual link (exponential
backoff), gated write ops (`dom.click` / `dom.setValue`, per-origin
authorization), and reload-stable tab addressing so the broker routes
follow-up queries back to the same tab. Source lives in `web-picker.src/`
(`npm run build` rebuilds the committed `web-picker.user.js`; protocol
constants come from the shared `wire.ts`).
Install — open the raw URL in a browser with Tampermonkey enabled;
the `.user.js` suffix triggers the install prompt automatically:

<https://raw.githubusercontent.com/azzgo/dotfiles/main/pi/agent/extensions/xfer/web-picker.user.js>

Manual install, shortcuts and troubleshooting:
[`docs/web-picker.md`](docs/web-picker.md).

## Usage

| Command | Meaning |
|---------|---------|
| `/xfer` | help |
| `/xfer list` | list peers (local socks) + listener status |
| `/xfer name [<name>]` | show or set this agent's name |
| `/xfer <target> <request>` | handoff to a peer (LLM doc + `xfer_to`) |
| `/xfer gc` | reap zombie peer sockets (dead pid / no listener) |
| `/xfer status` | listener status summary |

### Zombie socket GC

A peer that dies without cleaning up (crash, `kill -9`, closed terminal)
leaves `<name>.sock` + `<name>.json` behind. `/xfer gc` reaps them:

- `<name>.json` `pid` no longer alive (`kill(pid, 0)` → ESRCH) → remove both
- metadata missing/unreadable and nothing listening on the sock → remove both
- orphan `.sock` with no `.json` and no listener → remove the sock
- anything ambiguous (EPERM, probe timeout) is kept — gc never removes a
  peer that might be alive; `broker.*` files are never touched

### LLM tools

`xfer_to(target, summary, handoff_document)`:

1. write `/tmp/pi-xfer-<id>.md`
2. socket-notify target `{file, summary}`
3. return `handoff_id` immediately (no wait)

Reply by `/xfer <original sender> <message>` — each xfer is an independent
one-way message. **Exception:** a handoff whose sender is `web-picker` comes
from the browser userscript, not an agent — it has no xfer socket and can never
be an `xfer_to` target. The only return channel is the broker page-tool CLI
described in the doc's "Follow-up channel" section.

## Protocol

- Unix socket at `~/.pi/xfer/<name>.sock` (always on)
- Peer metadata at `~/.pi/xfer/<name>.json` (session name, cwd, model,
  status, pid, startedAt — refreshed by a 1s poll + status events)
- Message: `xfer-notify` (JSON lines, one-way; target remains the xfer name)

## Tests

```bash
npm test    # node --test, zero deps (inline .js→.ts resolve hook)
```

## Layout

| File | Responsibility |
|------|----------------|
| `index.ts` | entry wiring: flag, `xfer_to` tool, status events, lifecycle |
| `controller.ts` | inbound socket lifecycle: start / rename / shutdown |
| `commands.ts` | `/xfer` command (`list`, `broker`, `board`, `gc`, `status`, `name`, …) + completions |
| `board.ts` | async collaboration board: Markdown cards in `~/.pi/xfer/board/`, two-phase writes via `agent_end` interception |
| `gc.ts` | zombie-socket GC: dead-pid / orphan-sock detection + reap |
| `state.ts` | runtime identity + `<name>.json` metadata write/poll |
| `client.ts` | outbound `sendNotify` (connect → send → wait ack) |
| `server.ts` | inbound server: parse frames, deliver, ack (unix socket) |
| `utils.ts` | pure helpers: name encoding, endpoints, peer listing |
| `constants.ts` | paths + timeouts |
| `types.ts` | `PeerInfo`, `XferNotifyMessage`, `Identity` |
| `web-picker.user.js` | Tampermonkey page-side picker — see [docs/web-picker.md](docs/web-picker.md) |
