# Xfer — unidirectional cross-project handoff extension

Generate a markdown handoff doc via a `/handoff-style` prompt, send it via Unix
socket to another Pi instance. **One-way only, no wait.** Reply by calling
`/xfer` again.

## Install

```bash
just install-pi    # auto symlink ~/.pi/agent/extensions/xfer → repo folder
```

## Usage

| Command | Meaning |
|---------|---------|
| `/xfer` | help |
| `/xfer list` | list peers (Tab complete) |
| `/xfer name [<name>]` | show or set this agent's name |
| `/xfer <target> <request>` | handoff (LLM doc + `xfer_to`) |

### LLM tool

`xfer_to(target, summary, handoff_document)`

1. write `/tmp/pi-xfer-<id>.md`
2. socket-notify target `{file, summary}`
3. return `handoff_id` immediately (no wait)

Reply by `/xfer <original sender> <message>` — each xfer is an independent
one-way message.

## Protocol

- Unix socket at `~/.pi/xfer/<name>.sock`
- Peer metadata at `~/.pi/xfer/<name>.json` (session name, cwd, model,
  status, pid, startedAt — refreshed by a 1s poll + status events)
- Message: `xfer-notify` (JSON lines, one-way; target remains the xfer name)

## Layout

| File | Responsibility |
|------|----------------|
| `index.ts` | entry wiring: flag, `xfer_to` tool, status events, lifecycle |
| `controller.ts` | inbound socket lifecycle: start / rename / shutdown |
| `commands.ts` | `/xfer` command + argument completions |
| `state.ts` | runtime identity + `<name>.json` metadata write/poll |
| `client.ts` | outbound `sendNotify` (connect → send → wait ack) |
| `server.ts` | inbound socket server (parse frames, deliver, ack) |
| `utils.ts` | pure helpers: name encoding, endpoints, peer listing |
| `constants.ts` | paths + timeouts |
| `types.ts` | `PeerInfo`, `XferNotifyMessage`, `Identity` |
