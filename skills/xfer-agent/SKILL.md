# xfer-agent — hand off work to other agents

You are a non-pi **Agent Host** connected to the xfer network through
`xfer-adapterd`. Use this skill when the user asks you to hand work off to
another agent, or when you have an inbox with pending handoffs.

## Launch

This install's recommended command (generated at install time — do not build
flags yourself):

```
{{LAUNCH_COMMAND}}
```

Start it in the background at the beginning of a session. It owns the local
socket and the inbox. The command joins the mesh (`--mesh`) by default —
without it the daemon only has a local Unix socket and cannot reach mesh
peers; only drop `--mesh` when mesh is intentionally not configured.

## Read your inbox

The inbox is **take-to-read**: `take` atomically consumes the pending records and
prints one JSON object per line (each has `from`, `summary`, `file`, and the
document inline as `document`). Nothing durable is left behind.

```sh
xfer-adapterd inbox list   # peek, consumes nothing
xfer-adapterd inbox take   # consume every pending handoff
```

Read `document` (or the file at `file`) and act on it.

## Send a handoff

Write the handoff as a markdown file, then send it:

```sh
xfer-adapterd send <target> <file> <summary> --kind <task|notification>
```

`--kind` is required, and it *is* the reply contract. The tool writes the
`kind:` header line into the delivered doc (overriding anything you put there),
so you never hand-write it:

- `task` asks the target for output: it sends exactly one handoff back once it
  has a conclusion — done, blocked, or needing input.
- `notification` tells the target something and asks for nothing. It stays
  silent unless it is missing information, or the doc conflicts with fact.

Sending without a kind fails rather than going quiet, but the silence is what
you pay for a wrong one: an undeclared or mistaken `notification` never comes
back. Never send a handoff whose only purpose is to acknowledge.
- **Target search is LOCAL first.** `<target>` is another xfer node on this
  machine. Do not read `~/.pi/xfer/` by hand — ask the CLI:

  ```sh
  xfer-adapterd list          # one line per local peer
  xfer-adapterd list --json   # one JSON object per line, with sessionName/cwd/status
  ```
- `send` connects straight to the target socket and waits for its ack. It does
  **not** need the daemon to be running — send-only hosts can skip `up`
  entirely.
- Exit code is `0` on ack, `1` when the target is absent or fails.

Handoffs built in memory need no temp file: pass `-` as the file and the
document is read from stdin.

```sh
xfer-adapterd send <target> - "<summary>" --kind <k> < handoff.md
```

## Alternative: an MCP gateway instead of this skill

If your host speaks MCP, there is a stdio server that exposes the same sends as
typed tools — `xfer_send`, `xfer_mesh_send`, `xfer_list` — and needs no skill
file and no launch command:

```json
{ "command": "node", "args": ["<pi-xfer>/mcp-gateway.mjs", "--name", "<your-name>"] }
```

Two things to know before choosing it: `--name` is required (a send-only
gateway binds no socket, so a collision cannot be detected), and a host that
adopts it is **invisible in `/xfer list`** until something binds a socket with
`xfer-adapterd up`. It also cannot receive — there is no inbox behind it.
Details: `docs/guides/mcp-gateway.md` in the pi-xfer repo.

## Cross-machine (mesh) sends

Use the mesh **only when the user names a mesh actor** ("send to `phone` on the
mesh", "the agent on my other machine"). Never fall back to the mesh silently.

```sh
xfer-adapterd mesh send <target> <file> <summary> --kind <task|notification>
```

This needs `~/.pi/xfer/mesh.config.json` (or `--engine/--namespace/--token`).
Without it the command fails loudly — do not try to guess an endpoint.

## Rename this agent

The socket is bound to the name at startup. To rename, stop the daemon and start
it again with a different name:

```sh
xfer-adapterd up --name <new-name>
```

Local targets reach you by that name.

## Handoffs are one-way; the kind decides the return

There is no reply wait — `send` exits once the target's socket acks the enqueue.
The `kind:` line is the only thing that opens a return path, so declare it
deliberately.

Send back exactly one handoff when you hold a conclusion for a task, or when you
are missing information you need, or when the doc conflicts with fact. Never
send one to acknowledge: a receipt is not a reply.
