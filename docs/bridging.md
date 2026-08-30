# Xfer bridging — config-driven remote peers + bridge listener

Xfer's local flow (unix socket at `~/.pi/xfer/<name>.sock`) is unchanged. This
document covers the optional `~/.pi/xfer/settings.json` layer:

- **`peers.<name>.send`** — a one-shot command template that delivers a handoff
  frame to a REMOTE peer (another machine, a bot, an HTTP endpoint, …).
- **`listen.bridge`** — a command template that exposes this machine's xfer TCP
  listener through a tunnel (tailcat, `ssh -R`, …) so a remote peer can send
  frames back. Started explicitly with `/xfer listener setup`.

Everything external lives in settings.json; the wire protocol (`xfer-notify`
JSON-lines + `ack{msg_id}`) is byte-identical over unix sockets and TCP.

---

## settings.json schema

Optional file. Missing file ⇒ xfer behaves exactly as before. Unknown top-level
keys are tolerated.

| Key | Type | Meaning |
|-----|------|---------|
| `listen.bridge` | string | Command run by `/xfer listener setup`. Must contain `%p` (the local TCP port) if it should point at the xfer listener. |
| `peers.<name>.send` | string | Command run by `xfer_peer_to` / `/xfer peer` to deliver one frame to that peer. Required, non-empty. |
| `peers.<name>.timeoutMs` | number | Kill window for the send command (default `5000`). SIGTERM → 2 s grace → SIGKILL. |
| `peers.<name>.note` | string | Free-text hint shown in `/xfer list` and completions. |

```jsonc
// ~/.pi/xfer/settings.json
{
  "listen": {
    "bridge": "TAILCAT_ADDR_FILE=~/.pi/xfer/bridge.token tailcat --serve=%p"
  },
  "peers": {
    "bob-laptop": {
      "send": "tailcat tcBOBTOKEN 41732 < %msgfile",
      "note": "Bob's laptop; bridge token + port are fixed",
      "timeoutMs": 8000
    },
    "ci-hook": {
      "send": "curl -sS -X POST --data-binary @- https://ci.example.com/xfer",
      "note": "stdin branch — frame arrives on the command's stdin"
    }
  }
}
```

### Interpolation variables

Templates are interpolated before `sh -c` execution:

| Token | Value | Where valid |
|-------|-------|-------------|
| `%p` | TCP port of this session's bridge listener (`127.0.0.1:0`, ephemeral) | `listen.bridge` only — referencing it in a peer `send` throws (it is undefined there) |
| `%n` | This agent's xfer name (the frame's `from`) | both |
| `%peer` | The target peer's name | peer `send` only |
| `%msgfile` | Path of the temp file holding the frame (`/tmp/xfer-frame-*`, 0600) | peer `send` only |
| `%%` | Literal `%` | both |

Unknown `%token` → error naming the token and the template (catches typos like
`%msg`). A referenced-but-undefined variable → error (caller contract).

**`%msg` is intentionally absent.** The frame is model-generated markdown;
interpolating it into a shell argv would be command injection. Payloads reach
the command via the `%msgfile` path or stdin — never as an argument.

---

## Peer send: how a frame is delivered

`xfer_peer_to(target, summary, handoff_document)`:

1. frame = `{type:"xfer-notify", msg_id, from, file:/tmp/pi-xfer-<id>.md, summary}`
2. frame written to `/tmp/xfer-frame-*` (0600); `%msgfile` points at it
3. `interpolate(peer.send, {n, peer, msgfile, …})` → `sh -c <cmd>`
4. **branch on the raw template**: contains `%msgfile` → command reads the file
   itself (stdio `ignore/ignore/pipe`); otherwise the frame is piped to the
   command's **stdin**
5. wait ≤ `timeoutMs` (default 5 s); result is the **exit code only**
   (`0` = accepted). On failure the tool surfaces exit code + first 500 bytes
   of stderr. Fire-and-forget: ingestion on the remote side is the command
   author's concern.

### Examples

```jsonc
// tailcat — explicit port. The PORT ARGUMENT MUST BE LITERAL:
// it is Bob's port, not %p (that is YOUR listener port).
"send": "tailcat tcBOBTOKEN 41732 < %msgfile"

// tailcat — stdin pipe mode. Receiver runs a bare `tailcat` server
// (port 0 = stdin/stdout pipe) and ingests from its stdout.
"send": "tailcat tcBOBTOKEN < %msgfile"

// netcat — msgfile and stdin branches
"send": "nc bob.example.com 41732 < %msgfile"
"send": "nc bob.example.com 41732"          // frame arrives on stdin

// ssh — append the frame to a remote inbox file
"send": "ssh bob@example.com 'cat >> ~/xfer-inbox.jsonl' < %msgfile"
"send": "ssh bob@example.com 'cat >> ~/xfer-inbox.jsonl'"   // stdin branch

// curl — HTTP endpoint (stdin branch, binary-safe)
"send": "curl -sS -X POST --data-binary @- https://example.com/xfer-hook"
"send": "curl -sS -X POST --data-binary @%msgfile -H 'Content-Type: application/json' https://example.com/xfer-hook"
```

---

## Bridge listener: making this machine reachable

`/xfer listener setup` reads `listen.bridge`, binds an ephemeral TCP listener
on `127.0.0.1`, interpolates `%p` into the template, and runs it via `sh -c`.
The template typically **forwards a remote tunnel endpoint to that local
port**, so a peer on another network can deliver frames to this session.

- Bridge stdout/stderr are **display-only**: the first ~3 s are echoed to the
  human, everything goes into a 200-line ring buffer (`/xfer listener logs`).
  Nothing bridge-related ever enters the agent message stream.
- `/xfer listener stop` stops the command (SIGTERM → 2 s → SIGKILL) and closes
  the TCP listener. Session shutdown reaps automatically (2 s ceiling).
- Settings are read once per command — edit + rerun `setup`, no watcher.

### tailcat example (flags verified against `tailcat --help`)

```jsonc
// Receiver (this machine) — expose the xfer bridge listener via tailnet.
// TAILCAT_ADDR_FILE captures the connection token for the peer template;
// --full-address embeds DERP info so clients connect faster (optional).
"listen": {
  "bridge": "TAILCAT_ADDR_FILE=~/.pi/xfer/bridge.token tailcat --serve=%p"
}
```

Then copy the token from `~/.pi/xfer/bridge.token` into the remote peer's
`send` template (`tailcat tcBOBTOKEN <port> < %msgfile`), as shown above. The
port in the peer template must match the port the receiver served — `%p` is
only valid on the receiver side.

> There is no `--payload` flag: tailcat always carries the message on stdin
> (redirect or pipe), which is exactly what the templates above do.

### ssh -R example (no tailcat)

```jsonc
// Receiver: forward remote port 41732 on the relay host to the local listener.
"listen": { "bridge": "ssh -N -R 41732:127.0.0.1:%p relay.example.com" }
```

Peers behind the relay send with: `"send": "nc relay.example.com 41732 < %msgfile"`.

---

## Receiving-side patterns

The bridge command's author owns ingestion — xfer only guarantees that a frame
(a single JSON line) arrives. Three postures:

1. **Protocol-native** — the receiver runs an xfer session with
   `/xfer listener setup` fronted by a tunnel (above). Senders deliver real
   `xfer-notify` frames; the receiving session gets them as normal
   `📨 [Xfer from …]` handoffs (followUp when idle, steer when busy).
2. **HTTP endpoint** — the receiver exposes a webhook; senders use the curl
   template. The endpoint parses the JSON line and routes it (issue tracker,
   bot, CI trigger). Frame shape: `{type, msg_id, from, file, summary}` —
   `file` is a path on the SENDER's machine, so fetch/relay it if needed.
3. **File + watcher** — the sender appends frames to a file over ssh/nc;
   the receiver tails it (`tail -F ~/xfer-inbox.jsonl`) or a cron/launchd job
   consumes new lines.

Frame delivery is one-way by design. A receiver that wants to reply needs its
own xfer session + the original sender configured as a peer.
