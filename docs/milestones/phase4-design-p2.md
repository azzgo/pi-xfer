# Milestone 4 design — item 2 (local MCP gateway)

> Design node follow-up, 2026-10-19. Scope settled in `phase4-design-p2-p5.md`; this is the
> implementation plan that scope implies. Items 0+1 are in `phase4-design-p0-p1.md`
> (ADR-0020). No test may reach a deployed engine; the end-to-end mesh smoke is a human
> decision — see "Verification".

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

### v1 tool set: three tools

| Tool | Backs |
|---|---|
| `xfer_send` | `xfer-adapterd send <target> <file> <summary> --kind <task\|notification>` |
| `xfer_mesh_send` | `xfer-adapterd mesh send <target> <file> <summary> --kind <task\|notification>` |
| `xfer_list` | `xfer-adapterd list` (**new subcommand**, see below) |

The mesh tool is in scope, and the reason it is verifiable is worth stating precisely
because an earlier draft of this plan got it wrong. The gateway never talks to the engine:
it builds an argv and forks `xfer-adapterd`, so its mesh tool is verifiable in two ways: a
stub asserts the argv with no engine in the process, and — because a test may start its own
loopback control plane and the guard only blocks non-loopback — a second test can drive the
tool end to end against one. Everything below that layer (`sendMeshHandoff`, the fail-closed
preflight, the `not-delivered | unknown | failed` triage) is already covered by `mesh.test.ts`
through `fakeDeps`, and this change does not touch it. Conflating "should this be built"
with "how is this tested" is the mistake this paragraph exists to prevent: the deployed engine
being off-limits is a rule about *pollution*, not a reason to withhold a tool. Excluding it
would also have left a send-only host that can reach the local machine but not the mesh, which is
the same half-solution as shipping send without list.

`--no-preflight` is deliberately **not** exposed as a tool parameter: it is an escape hatch
for a human debugging the engine, and a model should not reach for it.

Receiving is out of scope: no inbox, no `xfer_inbox`, no `--on-handoff`. Delivery into a
non-pi agent's context is item 5, which was declined.
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
    tools: xfer_send       { target, summary, document, kind }
           xfer_mesh_send { target, summary, document, kind }
           xfer_list      { }
    argv:  xfer-adapterd send <target> <tmpfile> <summary> --kind <kind> --from <name> --dir <dir>
           xfer-adapterd mesh send <target> <tmpfile> <summary> --kind <kind> --from <name> --dir <dir>
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
5. **The gateway hands a model a second path to the engine.** `xfer_mesh_send` is thin, and
   the layer under it is already tested, so this is not a correctness risk — it is an
   exposure one, contained by three rules: `--no-preflight` is not exposed, so a model cannot
   disable the fail-closed check; the guard blocks the deployed engine for any process the
   test tree spawns, the gateway included; and loopback coverage means the path is exercised
   for real rather than asserted at the argv.
6. **The `.mjs` is untyped.** No compile-time check on argument shapes; the tests carry that
   weight instead.

## Verification

- `npm test` green — 567 tests, 566 pass, 1 skipped, 0 fail. Includes a real stdio JSON-RPC
  handshake against `mcp-gateway.mjs` (`initialize`, `tools/list`, `tools/call`); stdout purity
  including the error path; a stub `xfer-adapterd` on `--xfer-adapterd` asserting the exact
  argv for **all three tools**, so a CLI flag change cannot silently diverge from a tool
  schema; and every outcome asserted to be inside ADR-0020's four values, with a test that
  fails if a fifth appears.
- **Hermetic, and the barrier is structural rather than a rule to remember.** `node --test`
  sets `NODE_TEST_CONTEXT`, the environment is inherited by every descendant, and
  `mesh-guard.ts` refuses any non-loopback endpoint from both outbound planes. So the rule is
  precise, and worth stating precisely:
  - **Allowed:** `fakeDeps` stubs, and a control plane the test starts itself on loopback —
    `{"endpoint": "http://127.0.0.1:6420"}`. A test may therefore drive `xfer_mesh_send`
    end to end against a loopback engine, and should: argv-only coverage leaves the join
    and preflight path unexercised by the new file.
  - **Forbidden:** the endpoint, tunnel or relay named in the real
    `~/.pi/xfer/mesh.config.json`, and anything that needs its token. Not because it is a
    test — because it is *someone's deployment*, and a stray enqueue leaves a mark on it.
- **The gap against this plan.** The loopback end-to-end mesh test is written but
  `t.skip`ped, opt-in via `XFER_ENGINE_BINARY`. It cannot run unattended on this machine: a
  root-owned `rivet-engine` holds the default ports, so a second instance's guard service
  cannot bind, and the deployment named in the real config is remote, so there is no local
  engine to borrow. Everything below that layer (`sendMeshHandoff`, the fail-closed preflight,
  the `not-delivered | unknown | failed` triage) stays covered by `mesh.test.ts` through
  `fakeDeps`, and this change does not touch it. **Close it on a machine with the ports
  free**, or accept it knowingly — do not read the skipped test as passing coverage.
- Every test points `--dir` at a fresh `os.tmpdir()`.
- **A smoke against the real engine is still a human decision**, per AGENTS.md — and it buys
  little that a loopback test does not, so it is only worth asking for once the loopback path
  is green.
- Manual smoke, local only, 2026-10-19: a real stdio handshake against a throwaway
  `xfer-adapterd.cjs` — `initialize` ok, `xfer_list` returned the peer with metadata,
  `xfer_send` returned `{handoff_id, outcome: "delivered"}`, and the peer's inbox showed the
  right `from` and a correctly stamped `kind`.
