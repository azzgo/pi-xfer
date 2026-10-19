# Milestone 4 design — item 2 (local MCP gateway)

> Design node follow-up, 2026-10-19. Scope settled in `phase4-design-p2-p5.md`; this is the
> implementation plan that scope implies. Items 0+1 are in `phase4-design-p0-p1.md`
> (ADR-0020). Mesh access is out of scope here and out of scope for verification — see
> "Verification".

## The framing was wrong, and the correction changes the cost

`phase4-design-p2-p5.md` records a known cost of "one local gateway, many local agents":
every agent behind it shares one Node name, `/xfer list` collapses to one row, and receivers
see the gateway rather than the agent.

**That is not what a stdio MCP server does.** stdio means the host *spawns* the server and
owns its stdin/stdout, so there is one gateway process **per host session**, not one shared
process. Each one can carry its own name, and the cost largely evaporates:

| | one shared process (wrong) | one process per host session (actual) |
|---|---|---|
| `/xfer list` | collapses to one row | unchanged — a send-only gateway binds nothing, so it is not listed at all |
| receiver sees | `from: <gateway>` | `from: <that host's name>` |
| residual risk | — | two gateways configured with the same name, which is a config error |

So the stamp-the-calling-agent mitigation recorded earlier is demoted to an escape hatch for
the shared-name case, not a required part of the feature. The cost that remains is worth
naming once: **a send-only host is invisible in `/xfer list`**, because nothing binds a
socket for it. That is honest — sending does not require being listed — but it is a
difference a user will notice.

## What it is

A stdio MCP server exposing typed tools that shell out to the CLI that already exists. It
binds no socket, keeps no inbox, joins no mesh and runs no agent loop — the shape
`sendMeshHandoff`'s own docstring describes ("used by send-only hosts … which must not need
a daemon or a registered node of their own").

### v1 tool set: two tools, deliberately

| Tool | Backs |
|---|---|
| `xfer_send` | `xfer-adapterd send <target> <file> <summary> --kind <task\|notification>` |
| `xfer_list` | `xfer-adapterd list` (**new subcommand**, see below) |

`xfer_mesh_send` is **excluded from v1**. It would be one more argv, but exercising it means
reaching the engine, and shipping a path we cannot verify is exactly what ADR-0020 argues
against. It is added later, by whoever can test it against a local engine.

Receiving is out of scope: no inbox, no `xfer_inbox`, no `--on-handoff`. Delivery into a
non-pi agent's context is item 5, which was declined.

### Discovery needs a new subcommand

`xfer-adapterd` today is `up`, `send`, `mesh send`, `inbox take|list`, `install` — there is
**no way to list peers from the CLI**. `/xfer list` is a pi command. So a send-only gateway
would leave its host still needing a shell to find a target, which is half the problem the
feature exists to solve.

`xfer-adapterd list [--dir D] [--json]` prints the `~/.pi/xfer/*.sock` siblings with their
metadata, reusing `targets.ts`'s `listTargets` (plain `fs`, no pi dependency — it is
importable from the adapter bundle). One-line JSON per target with `--json` for machine
consumption. This also improves the skill path, which today tells the host to read the
directory by hand.

### Identity: `--name` required, never derived

The gateway must be started with `--name`. No default, no cwd derivation — a derived name
collides, and a collision here is invisible: a send-only gateway binds nothing, so
`claimEndpoint` cannot catch it the way it now catches duplicate daemons. `xfer-adapterd
install` generates the name it already generates today, so a normal install is correct by
construction.

If a user insists on one shared name, the stamping mitigation from
`phase4-design-p2-p5.md` applies: mark the calling agent in the document with the existing
`stampDocument` seam.

## No new build product

The gateway imports nothing from this repository — it is a thin wrapper around the installed
`xfer-adapterd` — so it can be a committed single file with no bundling step, alongside the
precedent of `broker-conn-module.test.js` / `page-tools-module.test.js`. AGENTS.md's four
build products are unchanged. `xfer-adapterd list` is added inside the existing bundle, so
`xfer-adapterd.cjs` and its `.sha256` rebuild as usual.

Cost of this choice: a plain `.mjs` gets no type checking. Accepted — the file is small, has
no repo imports, and is covered by tests.

## The change

```diff
  // adapterd.src/main.ts — discovery for hosts that cannot read a directory
  xfer-adapterd list [--dir D] [--json]

  // mcp-gateway.mjs  (new, stdio MCP server, no repo imports)
    tools: xfer_send { target, summary, document, kind }
           xfer_list { }
    argv:  xfer-adapterd send <target> <tmpfile> <summary> --kind <kind> --from <name> --dir <dir>
           xfer-adapterd list --json --dir <dir>
    flags: --name <n>  (required)   --dir <d>   --xfer-adapterd <path> (tests)
    stdout: JSON-RPC frames only — every diagnostic goes to stderr

  // adapterd.src/main.ts — accept an inline document on send
  - send <target> <file> <summary> --kind <k>
  + send <target> <file|-> <summary> --kind <k>
```

The gateway writes the handoff document to a temp file itself, exactly as `xfer_to` does at
`index.ts:107`, and passes the path.

## Touched areas

| File | Change |
|---|---|
| `mcp-gateway.mjs` (new) | the stdio MCP server; injectable exec seam for tests |
| `mcp-gateway.test.ts` (new) | JSON-RPC handshake, tool schemas, argv construction, stdout purity |
| `adapterd.src/main.ts` | `list` subcommand; `send` accepts `-` for a document on stdin |
| `adapterd.src/daemon.ts` | unchanged |
| `adapterd.test.ts` | cases for `list` and for `send -` |
| `xfer-adapterd.cjs`, `.sha256` | rebuilt by `npm run build` |
| `skills/xfer-agent/SKILL.md` | mention the gateway as an alternative to the CLI; point at `xfer-adapterd list` |
| `CONTRIBUTING.md` | unchanged |

Not touched: `index.ts`, `controller.ts`, `server.ts`, `client.ts`, anything mesh, anything
in `commands.ts`.

## Risks

1. **Stdout pollution corrupts the MCP session.** An MCP server that prints one stray line
   to stdout breaks the protocol, and the failure looks like a broken client, not a broken
   server. This is the most likely bug in the file; a test asserts stdout carries frames and
   nothing else, including on the error path.
2. **A send-only host is invisible in `/xfer list`.** Stated above; it is a behaviour change
   for anyone used to seeing a host there, and the docs must say a host appears only once
   something binds a socket for it (`xfer-adapterd up`).
3. **Name duplication is silent.** No socket means no `claimEndpoint` check. Install-generated
   names avoid it; a hand-written `--name` collision is the user's to manage.
4. **No receiving.** A host that adopts the gateway can still only *send*. Anything expecting
   inbound delivery will find nothing, and the skill must not imply otherwise.
5. **Mesh send is absent in v1**, so a host that today uses `mesh send` from a shell keeps
   needing that shell. Deliberate: an unverifiable path is not shipped.
6. **The `.mjs` is untyped.** No compile-time check on argument shapes; the tests carry that
   weight instead.

## Verification

- `npm test` green, including: a real stdio JSON-RPC handshake against `mcp-gateway.mjs`
  (`initialize`, `tools/list`, `tools/call`); stdout purity including the error path; and a
  stub `xfer-adapterd` on `--xfer-adapterd` asserting the exact argv for `xfer_send`, so a
  CLI flag change cannot silently diverge from the tool schema.
- Hermetic: every test points `--dir` at a fresh `os.tmpdir()`.
- **No mesh.** Nothing in this plan needs the engine, and nothing in its verification may
  touch it. A manual smoke (`initialize` + `tools/list` + one `xfer_send` against a real
  local `xfer-adapterd`) is a decision for the human, per AGENTS.md's rule that even a read
  against the deployed engine needs a yes.
