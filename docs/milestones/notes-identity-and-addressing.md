# Identity, addressing, discovery, reachability — research input (naming / same-name conflict / identity binding / reachability judgement / capability declaration / credentials, local + mesh + adapterd)
[简体中文](notes-identity-and-addressing.zh.md)

Provenance: commissioned read-only walkthrough of project `pi-xfer` at
`ae1121c` (branch `main`, 2026-10-18), requested by the human node of this project. No code was
changed; the only file written is this one. Nothing here touched a live deployment: no engine was
started, no `~/.pi/xfer` state was read, `XFER_ALLOW_REMOTE` was never set. Every engine fact below
is read from source, from the hermetic fakes in the tests, or from the ADRs. Terms follow
`CONTEXT.md` (Mesh, Node, Runner/pool, Delivery verdict, Adapter Daemon, Inbox, Handoff); no
synonyms are invented.

Prior note referenced throughout: `docs/milestones/notes-mesh-peer-identity.md` (archived in
`f7d5f9f`, 2026-10-17). Its mesh-side conclusions are marked **沿用 (carried forward)** or
**本次复核推翻 (overturned)**. The local-socket and adapterd identity semantics were not covered
there and are new work (§4, §5).

Claims are cited as `file.ts:line`, line numbers as of `ae1121c`.

---

## 0. Summary — the four layers, and which one is missing

| Layer | Where the truth lives | What it is | Bound to identity? |
|---|---|---|---|
| **Name** | a string on the wire and on disk | `xferName` | no — free text, unvalidated, never checked for uniqueness |
| **Address (local)** | `<xferDir>/<encodeURIComponent(name)>.sock` | filesystem path | no — the address *is* the name |
| **Address (mesh)** | actor type `xfer-instance` + single-segment actor key `[name]` | engine object | no — the key *is* the name |
| **Node ↔ host binding** | `MeshConfig.pool` (mesh), `<xferDir>` (local) | placement / directory | **partially** — pool binds an actor to a machine's Runner (`docs/adr/0017-mesh-runner-pools.md:20-26`); nothing binds a local peer's socket to the process that answers it |

There is no credential layer underneath any of them (mesh: §8.1; local socket: §8.3; adapterd:
§8.3). Identity is therefore "whatever the address resolves to at the moment of delivery", and a
name is a claim the sender makes about itself, not a fact the receiver checks.

---

## 1. Naming: where a name comes from

### 1.1 pi extension

`deriveName()` (`utils.ts:82-95`) — first match wins:

1. `--xfer <name>` flag (`utils.ts:83-84`; registered in `index.ts:24-29` as
   `pi.registerFlag("xfer", … default: undefined)`).
2. `.pi/settings.json` `name` field relative to the **current working directory**
   (`utils.ts:86-91`) — so the same extension binary yields different names in different
   directories.
3. Fallback `<basename(cwd)>_<4 random base36>` (`utils.ts:93-95`).

There is **no** validation of the result: no character set, no length cap, no reserved-name list, no
case folding. `/xfer name <new>` re-binds the socket under an arbitrary string
(`controller.ts:127-158`, `commands.ts:196-206`).

### 1.2 Adapter Daemon

`defaultAdapterName()` = `agent-<basename(cwd)>`, explicit `--name` used as-is
(`adapterd.src/daemon.ts:238-242`, wired at `adapterd.src/main.ts:115`). The `agent-` prefix is a
convention only; it is not enforced against a pi instance and nothing stops
`xfer-adapterd up --name alpha` from colliding with a pi session named `alpha`. `install` bakes the
name into the recommended launch command (`adapterd.src/main.ts:350-355`), so a host install is a
fixed name too.

### 1.3 What the name encodes — and what it does not

The name is simultaneously (a) the local socket file stem, (b) the metadata file stem, (c) the
adapterd Inbox stem, (d) the mesh actor key, and (e) the "return address" written into every Handoff
prompt the agent composes (`commands.ts:466`; `commands.ts:684`). One string, five
roles, no layer that can disagree with another — which is why same-name conflicts (§2) cannot be
reported by comparing "the name" against anything.

---

## 2. Encoding: name → filename, name → actor key

### 2.1 Local socket / metadata / Inbox

```
encodeAgentName(name) = encodeURIComponent(name)          utils.ts:13-15
decodeAgentName(s)    = decodeURIComponent(s), fallback s  utils.ts:17-23
endpointForName(name) = <xferDir>/<encode>.sock          utils.ts:25-27
metadataForName(name) = <xferDir>/<encode>.json          utils.ts:29-31
inboxPathForName(name)= <xferDir>/<encode>.inbox.jsonl   adapterd.src/inbox.ts:25-27
```

Properties worth recording:

- The mapping is **injective on strings** (percent-encoding is), so two distinct names cannot
  collapse onto one file — `a b` and `a%20b` differ (`a%20b` encodes to `a%2520b`).
- The mapping is **lossy for `/`**: `encodeURIComponent("/")` is `%2F`, so a name containing `/` is a
  legal single file stem. Nothing constrains `.`/`..` either: `encodeURIComponent("..")` is `..`, so
  `--xfer ..` names the socket `<xferDir>/...sock` (harmless as a filename, but nothing in
  `endpointForName` rejects it — the only structural guard is that the path is `join`ed, so an
  encoded name can never contain a literal separator).
- **`decodeAgentName` is applied when listing** (`utils.ts:114-116`, `targets.ts:51-53`,
  `gc.ts:74-86`) and **not** when parsing metadata: `targets.ts:52` decodes the socket stem, then
  reads `<same stem>.json` (`targets.ts:53`) — no re-encoding round trip, by design (`targets.ts:37-41`).
  The one place that skips decoding is `broker-main.ts:259`'s `pushXferNotify`, which re-encodes the
  name from the wire — consistent, since the wire carries the decoded name.
- A malformed percent sequence in a socket filename degrades to the raw stem (`utils.ts:19-22`)
  rather than throwing; `gc` and `listPeers` therefore cannot fail on a foreign file name.

### 2.2 Mesh actor key

`XFER_INSTANCE_ACTOR = "xfer-instance"` (`mesh-config.ts:29`), one actor per Node, key = `[name]`
(`mesh-engine.ts:269-272` `client.getOrCreate(XFER_INSTANCE_ACTOR, [name], …)`). Key serialization mirrors the
engine (`mesh-config.ts:405-417`), with the reverse direction used when mapping `/actors` rows back
to names (`mesh-engine.ts:488-496`, `deserializeMeshKey` at `mesh-config.ts:419-439`).

- `serializeMeshKey` escapes `\` → `\\` and `/` → `\/`, and maps an empty part to `\0`
  (`mesh-config.ts:410-417`); `deserializeMeshKey` reverses it.
- **Only `deserialized[0]` is used as the node name** (`mesh-engine.ts:491`): a multi-segment key
  would be silently truncated to its first segment in every listing, while `queueSend` addresses
  `[target]` — a one-segment key (`mesh-engine.ts:303`). Anything on the engine that ever wrote a
  two-segment key would appear under a name it cannot be reached at.
- An empty name is representable end-to-end: `deserializeMeshKey` returns `[]` for `""`/`"/"`
  (`mesh-config.ts:420`), and `toMeshNodeInfo` then reports `name: ""` (`mesh-engine.ts:491`). No
  producer in this repo emits one; nothing rejects one.

### 2.3 The three-way correspondence

`<name>.sock` ⇄ `<name>.json` ⇄ `actor(xfer-instance, [name])` holds on one host only because all
three are derived from the same string at the same moment. There is **no** reconciliation, and no
code ever compares a mesh actor key against a local socket name:

- pi: `/xfer mesh up` joins as `state.identity.name` (`commands.ts:358`), the same string the socket
  was bound to at `controller.start()` (`controller.ts:96-97`). One process cannot diverge.
- Adapter Daemon: `--name` (or its `agent-<dir>` default) becomes the socket stem *and* the mesh key
  (`adapterd.src/daemon.ts:66-69, 173-182`). Also cannot diverge within itself.
- Across hosts, the relationship is spelling only: this machine's `alpha` socket and another
  machine's `alpha` actor share a string and nothing else. `xfer_to` and `xfer_mesh_to` are separate
  tools against separate namespaces (`index.ts:71-76`, `index.ts:157-167`), and the only cue the agent
  gets that a name is the wrong one for a transport is the error text of the attempt.

---

## 3. Same-name conflicts: what is detected and what is not

### 3.1 Mesh: detected, with a documented residual window

`MeshNode.up()` reads the engine listing **before** creating, and refuses only on `Running`
(`mesh.ts:163-173`):

```
conflict = existing.find(node => node.name === name)         mesh.ts:163
conflict?.status === "Running"  → throw (points at the other host)   mesh.ts:164-172
conflict (other statuses)       → assertPoolMatch() then adopt      mesh.ts:173
```

- The rule and its rationale are ADR 0016 (`docs/adr/0016-actor-adoption.md:36-48`): non-`Running`
  actors are adopted (never destroyed), `Running` is refused because the same key would silently
  route this process's traffic to the other host.
- **Adoption is name takeover, not identity check.** `up()` never asks *who* the sleeping actor was;
  it re-resolves the same actor and reuses its durable state — including `description`
  (`docs/adr/0016-actor-adoption.md:40-43`). Whoever calls `up("alpha")` next inherits `alpha`'s
  self-declared capability note. This is a name-resolution property, not a defect in the ADR, but it
  is the one place where a *name* transfers capability information between unrelated hosts.
- The residual window is documented as a rough edge, not a bug: a just-crashed actor may keep
  `connectable_ts` set and therefore read `Running` until the engine notices the runner is gone, so
  the refusal can be a false positive just after a crash; adoption adds no retry loop, by decision
  (`docs/adr/0016-actor-adoption.md:28-32`).
- **`Running` is the only conflict signal; reachability is not consulted.** The pre-create check
  reads the actor record only, so a `Running` actor whose pool holds no live Runner still blocks
  adoption — the refusal is correct (another process may own the key), but the message
  ("already Running on another host") can name a host that cannot currently receive anything. The
  reverse case is why the delivery verdict exists at all: `no_envoys` reads `Idle`, not `Running`
  (`mesh-engine.ts:127-134`), so a runner-less actor is *adoptable* rather than refused. A `Running`
  actor in a *different* pool than this host's config is refused by the `Running` branch before
  `assertPoolMatch` is reached (`mesh.ts:164-173`) — the pool mismatch is then never mentioned.
- The admin console can destroy **any** listed node's actor, including one `Running` on another host,
  behind a confirm (`admin-main.ts:437-448, 793-831`). It re-checks the actor id against the listing
  before destroying (`admin-main.ts:821-824`), which closes the render-vs-destroy race but not the
  "someone else's node" case.

### 3.2 Local socket: **not detected at all**

This is the largest gap in this file, and it is a deliberate absence rather than an oversight in one
place:

- `controller.start()` unlinks any existing `<name>.sock` and `<name>.json` before binding
  (`controller.ts:98-100`): a second pi session started with the same name **steals** the name from
  the first, which keeps running with a now-unlinked socket. Handoffs addressed to that name go to
  the newcomer; the loser receives nothing and is told nothing.
- `controller.rename()` does the same for the new name (`controller.ts:138-141`).
- `startAdapterd()` unlinks `endpoint` and `metadataPath` before listening
  (`adapterd.src/daemon.ts:75-78`) — an adapterd started under a live pi session's name steals it the
  same way, and vice versa.
- The failure mode on the *losing* side is silent: its `net.Server` is still listening on an unlinked
  inode, so its `listenServer` error handler (`server.ts:56-63`) never fires; its metadata poll
  (`state.ts:56-61`) keeps rewriting a file that is no longer the live one for that name.
- Detection exists only *downstream*, as `/xfer gc`'s heuristics on leftovers of a dead process
  (`gc.ts:20-32`, `planGc` at `gc.ts:82-143`): dead pid → reap, `ECONNREFUSED` → reap, anything
  ambiguous → keep. `gc` cannot see two live processes for one name, because a stolen name leaves at
  most one `.sock` file.
- `/xfer list` (`commands.ts:184-193`) enumerates socket files; two processes under one name collapse
  into one row.

### 3.3 Local vs mesh: opposite behaviour for the same input

| Input | Mesh (`MeshNode.up`) | Local (`controller.start` / `startAdapterd`) |
|---|---|---|
| no such name | create | create |
| same name, other holder idle/offline | adopt (`mesh.ts:173`) | **steal** (`controller.ts:98-100`) |
| same name, other holder live | refuse (`mesh.ts:164-172`) | **steal, silently** |

ADR 0013's "check first, occupy second, refuse rather than auto-rename" (`docs/adr/0013-xfer-mesh-rivetkit-transport.md:10`, refined by `:26`) is
implemented for the Mesh only. The local transport has no equivalent decision recorded anywhere in
`docs/adr/`; the unlink-before-bind is written as if a stale socket were the only possible
occupant (`controller.ts:98`).

---

## 4. Identity authenticity — local socket (new; not in the previous note)

### 4.1 What a local peer actually proves

The wire is JSON-lines over `AF_UNIX` (`server.ts:12-46`): the only accepted frame is
`{type: "xfer-notify", msg_id: string, …}` (`server.ts:35-39`), answered with
`{type:"ack", msg_id}` (`server.ts:40`). The inbound `from` field is **not** read at all by the
server — `delivery.deliver(msg as XferNotifyMessage)` (`server.ts:37`) passes the frame through
verbatim, and `controller.deliverInbound` renders `msg.from` straight into the prompt
(`controller.ts:36, 42-45, 46`), and the mesh path labels the same string with `· mesh` (`controller.ts:33, 58`).

So a local Handoff's claimed sender is whatever the connecting process put in the frame:

- `xfer_to` sends `from: state.identity.name` — true (`index.ts:118-124`).
- `broker-main.ts` sends `from: FROM_WEB_PICKER` (`broker-main.ts:402-408`) and the receiving session
  special-cases that exact string to steer the agent away from replying
  (`controller.ts:48-58, 61-77`). **The string is forgeable**: any local process that connects to
  `<name>.sock` and writes `{"from":"web-picker"}` gets the browser treatment; conversely a real
  broker whose constant ever changed would lose it. There is no channel binding between the frame and
  the sending socket, because the receiving side never inspects the peer's credentials.

### 4.2 What does bind (weakly)

- **Filesystem permissions**: `<xferDir>` is `0700` and the socket is `chmod 0600`
  (`controller.ts:94-95`; `server.ts:66`; `adapterd.src/daemon.ts:226`) — so the *user account* is the
  unit of trust. Any process running as the same user can send as anyone.
- **`pid` in metadata**: `<name>.json` carries `pid` and `startedAt` (`state.ts:33-41`;
  `adapterd.src/daemon.ts:92-107`). This is used as a liveness proxy in three places — `hasLivePeer()`
  gates `xfer_to`'s presence in the prompt (`index.ts:51-59`), `peerRows()` labels local peers
  online/zombie (`admin-main.ts:106-119`), `planGc()` decides what to reap (`gc.ts:82-143`) — and
  **never** as an identity check. `utils.readPeerMetadata` (`utils.ts:63-79`) reads `pid` but no
  caller compares it against a sender.
- **`startedAt`**: written, never compared. Two processes with one name cannot be told apart by it.

### 4.3 What cannot be determined today

1. Whether the frame that just arrived came from the process that owns the socket's metadata `pid`.
2. Whether the claimed `from` corresponds to any live local peer at all.
3. Whether the sender is a pi session, an Adapter Daemon, or the broker — `broker-main.ts:402` is the
   only producer that sets a marker (`FROM_WEB_PICKER`), and it is a string, not a channel property.
4. Whether a peer that appears in `/xfer list` is the process that will answer a connect (a stolen
   name answers instead).

---

## 5. Identity authenticity — Adapter Daemon (new; not in the previous note)

The Adapter Daemon is not a distinct identity kind: it is a second implementation of the same local
peer, with the same socket, the same metadata schema plus two extra fields, and the same lack of
authentication.

- Metadata written per daemon (`adapterd.src/daemon.ts:82-108`): `xferName`, `sessionName:
  "<host> adapter"`, `cwd: process.cwd()`, `model: "adapterd"`, `status: "idle"` (constant),
  `pid`, `startedAt`, plus `kind: "adapterd"`, `host`, `inbox`.
- The `kind` field is the only durable marker that distinguishes an adapterd row from a pi row, and
  it is **self-reported and unvalidated**: `listTargets()` (`targets.ts:42-54`) reads
  `sessionName/cwd/status/description` and **drops `kind`, `host` and `inbox`** (it is
  `Pick<TargetInfo, "sessionName" | "cwd" | "status" | "description">`, `targets.ts:8-12`). So the
  broker's `targets.list` (`broker-main.ts:501-508`) cannot show a picker user what kind of host a
  target is. Only the `skills/xfer` wrapper reads `kind` (`skills/xfer/scripts/xfer:90`), and only
  because it re-implements the scan.
- `status` for an adapterd is the literal string `"idle"` forever
  (`adapterd.src/daemon.ts:88`) — it is not busy/idle truth, unlike pi's event-driven
  `state.currentStatus` (`index.ts:206-209`).
- The Inbox is the daemon's own append-only record (`adapterd.src/inbox.ts:11-23`), and its
  `from` comes from the frame like everything else (`adapterd.src/daemon.ts:141-163`).
- Daemon liveness is discoverable only indirectly: `inbox take|list` with an explicit `--name` refuses
  when `<name>.sock` is absent (`adapterd.src/main.ts:306-309`), and without `--name` it adopts the
  single `kind: "adapterd"` metadata in the directory, refusing on 0 or >1
  (`adapterd.src/main.ts:321-341`). Both are filesystem facts, not process facts.
- The adapterd joins the Mesh with the very same `MeshNode` (`adapterd.src/daemon.ts:168-190`), so
  ADR 0016's adoption/refusal semantics apply to it identically — the ADR says so explicitly
  (`docs/adr/0016-actor-adoption.md:37-38`). A mesh-side `alpha` and a local-side `alpha` can therefore
  be the same process (adapterd), two processes (adapterd + pi), or one process and nothing — and
  nothing in the system can tell which.

---

## 6. Reachability: what each surface reports, and what it cannot

The vocabulary is fixed by `mesh-status.ts:1-12` and `CONTEXT.md` ("Delivery verdict" ≠ "actor
status"; "Offline" is never a verdict). Two different questions exist and are answered by different
code:

- **Local: "is there a socket with that name?"** — a filesystem fact, never a connectivity fact.
- **Mesh: "is the actor listed, and does its pool hold a live Runner?"** — an engine fact, never a
  delivery fact.

### 6.1 `/xfer list` (`commands.ts:184-193` → `listPeers`, `utils.ts:110-125`)

Reports: one row per `*.sock` file, with `xferName`, `sessionName`, `cwd`, `model`, `status`,
`description` merged from `<name>.json` (`utils.ts:114-123`; rendering at `commands.ts:186-189` and
`utils.ts:39-46`).

**Does not report**: whether anything is listening (no connect is attempted — `targets.ts:37-42`
states the same rule for `listTargets`), whether the recorded `pid` is alive (`listPeers` never calls
`process.kill`; only `index.ts:51-59` and `admin-main.ts:107-119` do), whether the metadata is stale,
or whether two processes share the name. A stale `.json` next to a stale `.sock` renders exactly like
a live peer.

### 6.2 `/xfer status` (`commands.ts:648-651`)

Reports only this session's own listener line: `unix socket: <endpoint> — name "<name>"`, or
`(not initialised)` (`commands.ts:39-44`). It says nothing about clients, backlog, or accept state.

### 6.3 `/xfer doctor` (`doctor.ts:65-82`)

- `Socket dir` — exists and is writable (`doctor.ts:117-134`).
- `Peers` — `listPeers(myName)` **minus** the zombie set computed by `planGc` (`doctor.ts:136-146`).
  This is the one local surface that joins a filesystem scan with a connectivity probe
  (`planGc` calls `socketHasListener`, `gc.ts:60-79, 117, 135`), and it is still not a proof of who is behind
  the socket: `socketHasListener` treats timeouts and errors other than
  `ECONNREFUSED`/`ENOENT`/`ENOTSOCK` as "listening" on purpose (`gc.ts:71, 75-76`).
- `Broker` / `Admin` — probe only (`doctor.ts:148-170`).
- `Mesh` — `loadMeshConfig` + `resolveMeshConfig` + `listMeshNodes` under `MESH_PROBE_TIMEOUT_MS`
  (`doctor.ts:172-201`): reachability of the engine, node count, and a `warn` when any listed actor
  reads `status === "Idle"` (`doctor.ts:187-199`). Note `doctor.ts:187`'s `"Idle"` is the **actor
  lifecycle** state (`mesh-engine.ts:114-134`), not the codebase's `currentStatus` — the name
  collision flagged in `notes-reason-network-wake.md` §10 still exists. `doctor` does **not** join
  `/envoys`, so it cannot produce a Delivery verdict; its mesh line is weaker than `/xfer mesh list`.

### 6.4 `/xfer mesh list` (`commands.ts:383-401` → `mesh.state()` → `listMeshState`)

Reports one row per listed actor with the **Delivery verdict** `Running | Sleeping | NoRunner |
Mismatch | Pending | Crashed | Unknown` plus pool and reason (`mesh-status.ts:23-31, 71-107`;
`deriveMeshNodeState` at `mesh-engine.ts:429-441`; `listMeshState` at `mesh-engine.ts:450-455`).

The verdict is the join of two independently-failable engine reads: `GET /actors?name=xfer-instance`
(`mesh-engine.ts:475-483`) and `GET /envoys` (`mesh-engine.ts:461-464`). **`envoys: null` means
"the engine did not answer"** and every row renders `Unknown` with the reason "its pool's runners are
unknown" (`mesh-engine.ts:433`; `mesh-status.ts:72`). The file is explicit that absence of
a runner is not absence of a node (`mesh-status.ts:1-12`).

**Does not report**: whether the actor's Runner is the *same machine* the human thinks it is (pool
names are self-assigned strings, §6.6); whether a listed node is in this host's namespace (the
listing is namespace-scoped by the config, `mesh-engine.ts:362-363`); whether the node is a genuine
pi-xfer instance (actor type is the only filter — carried forward from the previous note, §8.1);
whether a Handoff enqueued now would actually be consumed (queue depth, ack state, and per-message
outcome are not on the listing).

### 6.5 `/xfer mesh status` (`commands.ts:402-419` → `meshSelfStatus` + `meshStatusLines`)

Reports the *receiving* side of the same question — "can anything reach me?" — as: online-in-this-
session or not, the engine endpoint, whether this host's pool has a live Runner and how many, node
count, and a `→ fix` line when it does not (`mesh-status.ts:146-183`). `meshUnreachableLines` is the
separate shape when the engine did not answer at all (`mesh-status.ts:201-207`).

**Does not report**: whether the queue currently holds undelivered Handoffs; whether the actor is
adopted by another process; whether the Runner in the pool is the one this process started (a pool is
a set of Runners, not a process: `mesh-engine.ts:424-426`).

### 6.6 The pre-send check (mesh) — real, and fail-closed

`preflightMeshSend` (`mesh-engine.ts:563-604`) is what makes "does the target exist" answerable
*before* an enqueue, and `MeshNode.send()` always runs it (`mesh.ts:248-256`):

- engine did not answer `/actors` or `/envoys` within `PREFLIGHT_TIMEOUT_MS` (6 s,
  `mesh-engine.ts:510`) → `MeshPreflightError`, nothing sent, text says so
  (`mesh-engine.ts:567-581`);
- target not in the listing → `MeshPreflightError` naming "never brought up there … or its actor was
  destroyed" (`mesh-engine.ts:591-598`);
- `NoRunner` → blocked (`mesh-engine.ts:518-526`); `Mismatch` → warning only, engine places it on the
  next send (`mesh-engine.ts:527-534`).
- The enqueue itself is still tri-state: `not-delivered` (engine said
  `guard.actor_ready_timeout`), `unknown` (we stopped waiting — may still arrive), `failed`
  (`mesh-engine.ts:652-661`). `unknown` is precisely the case where reachability was true at
  preflight and false at enqueue.

**`MeshNode.send()` always pays the preflight** even when `up()` already proved the node online —
the `verified` parameter exists for exactly this (`mesh-engine.ts:171-177`), but `send()` calls
`preflight` then `queueSend(target, message, verified)` (`mesh.ts:249-251`), so a normal in-session
send costs one extra engine round. The adapterd's `mesh send` has an escape hatch,
`--no-preflight` (`adapterd.src/main.ts:320-338`).

### 6.7 Local: no pre-send check beyond `existsSync`

`xfer_to` → `sendNotify` (`client.ts:9-16`): `fs.existsSync(endpoint)` else
`peer "<target>" not found`; then connect with `CONNECT_TIMEOUT_MS` 5 s
(`constants.ts:14`) and ack with `ACK_TIMEOUT_MS` 5 s (`constants.ts:15`). `/xfer <target> <req>`
runs the same `existsSync` gate one layer earlier (`commands.ts:664-668`) so the agent is never asked
to compose a doc for a name with no socket. The distinction the previous note flagged on the mesh side
("process present but socket unreachable" vs "metadata stale") is **only partially** available here:

| Situation | What the sender sees |
|---|---|
| socket file gone | `peer "x" not found` (`client.ts:10-13`) |
| socket file present, no listener | connect fails → `ECONNREFUSED` surfaces as the raw socket error (`client.ts:84`), after up to 5 s |
| socket present, listener accepts but never acks | `ack timeout` (`client.ts:51`) |
| socket present, listener acks | success — but the ack means "`deliver()` returned", not "the agent read it" (`server.ts:35-40`) |
| metadata stale, socket live | indistinguishable from fresh; `listPeers` merges whatever the `.json` says (`utils.ts:110-125`) |
| socket live but *not* the named process | indistinguishable (§3.2) |

The last row is the one that has no mesh analogue at all: mesh misrouting is *detectable* after the
fact (`onHandoff` compares `message.to` with the actor key this process owns and refuses with
`onMisroute`, `mesh.ts:303-366`), while a local delivery to a name-stealing process is
indistinguishable from a correct one — there is no `to` in the local frame to compare
(`types.ts:17-23`).

### 6.8 Admin console

`/control` shows local peers with an `online` flag derived from `pid` liveness
(`admin-main.ts:107-119, 468-475`) and mesh nodes with the same verdict glyphs
(`admin-main.ts:430-466`), plus a `down` button per node (§3.1). It reads `listPeers` (not
`listTargets`), so it also drops `kind`, `description`, `model`.

---

## 7. Capability declaration (`/xfer desc`) — what "unverified self-declaration" means in code

README's sentence — "Unverified self-declaration — routing stays with the consumer"
(`README.md:38`) — is accurate and slightly understated. The precise semantics:

### 7.1 Storage: two places, and only one of them is the Mesh

- **Local**: `state.description` on the `XferState` (`state.ts:11`), written into `<name>.json` as
  `description` when non-empty (`state.ts:33-41`; set via `/xfer desc` at `commands.ts:225-231`
  followed by `state.writeMetadata(true)` at `commands.ts:228`).
- **Mesh**: the actor's durable state, `XferInstanceState.description` (`mesh-engine.ts:18-24`),
  written by the `setDescription` actor action (`mesh-engine.ts:75-78`, wired at
  `mesh-engine.ts:230`), read by `getDescription` (`mesh-engine.ts:80-82`, wired at `mesh-engine.ts:231`).
- **The two are synced only opportunistically**: `/xfer desc` writes locally and then, if this
  process is mesh-online, pushes to the actor (`commands.ts:231-250`); `/xfer mesh up` re-pushes the
  local value after joining (`commands.ts:364-368`). A `desc` set on another host is never pulled
  back, and an actor's description set by another process (adoption, §3.1) never lands in the local
  `.json`.
- **`MAX_NODE_DESCRIPTION = 500`** (`mesh-engine.ts:35`), enforced on the mesh write path
  (`normalizeNodeDescription`, `mesh-engine.ts:58-68`). The **local** write path has no cap:
  `commands.ts:226-228` stores the whole remainder of the command line. So `/xfer desc` can succeed
  locally and then fail its mesh sync with "description is limited to 500 characters"
  (`mesh-engine.ts:63`), which `commands.ts:241-245` reports as "Saved locally, but mesh sync failed".

### 7.2 Read paths — three of them, with different reach

| Reader | What it reads | Reaches |
|---|---|---|
| `MeshNode.describe(target)` (`mesh.ts:221-223`) | `getDescription` action on the target actor | mesh only; **no in-repo caller** |
| `createMeshDescriber` (`mesh-describer.ts:25-36`) | same action, 5 s timeout (`mesh-describer.ts:19`), degrades to `undefined` | broker's `targets.list` only (`broker-main.ts:503-504`) |
| `listTargets` (`targets.ts:42-54`) | the local `<name>.json` `description` | any local reader (admin drops it, §6.8) |

`TargetInfo.description` is documented as absent-means-unknown, never an empty placeholder
(`types.ts:36-46`), and `listTargetsWithDescriptions` swallows a rejecting describer so a listing can
never fail because of one (`targets.ts:67-80`, comment at `targets.ts:36-41`). Note the docstring at
`targets.ts:36-41` describes an "offline actor / engine down / no mesh configured" rejection path
while the implementation catches it — consistent, but the *reason* never reaches a consumer: the
human picking a target sees no description and no explanation.

### 7.3 "Unverified" and "routing stays with the consumer", precisely

- **Unverified**: nothing validates the text. It is a free string, capped at 500 chars on the mesh
  path only, and any process that can reach the actor (including a foreign `xfer-instance`, §8.2) can
  set it. It is not signed, not versioned, not machine-checked against any capability list.
- **Routing stays with the consumer**: nothing in `index.ts`, `commands.ts`, `mesh.ts` or
  `mesh-engine.ts` branches on a description. `xfer_mesh_to` requires the model to name a target
  (`index.ts:164-165`) and never fetches a description to help it; `/xfer mesh list` renders
  **names + verdicts only**, deliberately (`mesh.ts:217-220`: "listings stay names-only, so consumers
  loop this and cache locally"); the console shows no description at all (§6.8). The only consumer
  that turns a description into a decision is the **human** in the web picker
  (`broker-main.ts:501-508`), and the only place the description is *persisted* outside the actor is
  the skill wrapper's local cache (`skills/xfer/scripts/xfer:62-71`, reading `descriptions.json`) —
  a store this repo never writes (`descriptions.json` appears nowhere in `*.ts`), so for a
  freshly-installed host the "cached locally" branch is permanently empty.

### 7.4 Reachability of the declaration

A description lives with the actor, so it is readable **while the node is offline** — the actor's
state is the engine's, `MeshNode.up()`'s comment says so (`mesh.ts:141-145`), and `getDescription`
uses `client.get` (no create) so it will resolve a sleeping actor. What a description *cannot* tell a
consumer is whether the node is currently able to receive; that is the verdict's job (§6.4), and the
two are read by different code paths (broker: description only; CLI: verdict only). **No single
surface today shows both together.**

---

## 8. Credentials — where authentication stops

### 8.1 Mesh: one root credential, no per-peer identity (carried forward, re-verified)

- `MeshConfig.token` (`mesh-config.ts:7-9`), resolved from a literal, `$ENV_VAR`, or `!command`
  (`mesh-config.ts:360-395`), refused in URL userinfo (`mesh-config.ts:52`,
  `rejectUrlAuth` at `mesh-config.ts:92-119`).
- The token travels on every engine plane: REST `Authorization: Bearer` (`mesh-engine.ts:358`), and
  through `setup({ token })` / `createClient(...)` (`mesh-engine.ts:252-260`, `mesh-engine.ts:266`).
  ADR 0019 records what that means: the admin token is a root credential, and it also rides as a
  WebSocket subprotocol and a URL path segment (`docs/adr/0019-mesh-transport-security.md:36-40`).
- **There is no peer-level credential.** Peer identity = actor type name + key, no handshake
  (`docs/adr/0019-mesh-transport-security.md:41-43`). Re-verified against today's tree: the actor
  definition registers `setDescription`/`getDescription` and one queue, and nothing else
  (`mesh-engine.ts:224-266`); `XferInstanceState` has no protocol version and no identity field
  (`mesh-engine.ts:18-24`); discovery filters on the actor type alone
  (`mesh-engine.ts:475-483`).
- One credential behaviour worth recording: `if (config.token) headers.Authorization = …`
  (`mesh-engine.ts:358`) — with no token configured the request goes out **unauthenticated** rather
  than failing locally; whether that is accepted is the engine's decision
  (`docs/guides/mesh-setup.md:44` notes current engines require auth unless
  `auth.insecure_allow_unauthenticated: true`).
- `mesh-guard.ts` is *not* an authentication layer: it only refuses non-loopback endpoints while
  `NODE_TEST_CONTEXT` is set (`mesh-guard.ts:62-64, 86-98`).

### 8.2 The consequence for addressing

Because the token is namespace-wide and the actor key is the address, **holding the token is
sufficient to be `bob`** (ADR 0019: "A same-namespace actor registering as `xfer-instance` is
indistinguishable from a real node", `docs/adr/0019-mesh-transport-security.md:84-86`). This is the
one thing in this survey that no surface can report: `/xfer mesh list` will show two `bob` rows if two
actors somehow share a key (they cannot — key uniqueness is the engine's), and one `bob` row when the
only `bob` is an impostor.

### 8.3 Local socket and Adapter Daemon: no authentication whatsoever

- `createServer` accepts any connection and any well-formed `xfer-notify` frame
  (`server.ts:12-46`); no peer-credential lookup is possible on `AF_UNIX` in this design and none is
  attempted.
- The only access control is the mode bits: dir `0700`, socket `0600`
  (`controller.ts:94-95`, `server.ts:66`, `adapterd.src/daemon.ts:226`), metadata `0600`
  (`state.ts:47-48`).
- The broker's own surface is "localhost-trust" by construction: bound to `127.0.0.1`
  (`broker-main.ts:102, 879`) and its `auth_failed` branch explicitly says there is nothing to
  authenticate (`broker-main.ts:818-823`). The WebSocket upgrade handler checks the path and the
  `Sec-WebSocket-Key` header and nothing else — **no `Origin` check**
  (`ws-server.ts:186-204`). Since `annotation.submit` writes a document and pushes an
  `xfer-notify` into a named target socket (`broker-main.ts:399-417`), any process that can open a
  local WebSocket (including a web page in a local browser, which needs no CORS preflight for a
  WebSocket) can submit a Handoff to any local peer under the `web-picker` identity. This is a
  local-trust design, recorded here as a fact, not as a defect claim.
- The adapterd's `--on-handoff` spawns a shell command per Handoff with data on stdin and three
  `XFER_HANDOFF_*` env vars (`adapterd.src/daemon.ts:110-139`). The values are the sender's
  self-declared strings; a consumer that interpolates `XFER_HANDOFF_FROM` into a shell line is
  interpolating an attacker-controlled string.

---

## 9. Verification of the previous note (`notes-mesh-peer-identity.md`)

Method: every load-bearing claim re-read against `ae1121c`. The note was archived at `f7d5f9f`
(2026-10-17); `mesh-engine.ts` (+502), `mesh-config.ts` (+369) and `mesh.ts` (+87) all changed since,
so line numbers moved but the structural claims did not.

| # | Previous claim | Verdict | Evidence today |
|---|---|---|---|
| 9.1 | Peer identity is actor type name + single-segment key; no handshake, no credential | **沿用** | `mesh-config.ts:29`; `mesh-engine.ts:224-266, 475-496`; ADR 0019:41-43 |
| 9.2 | `XferInstanceState` is `{description}` only — no protocol version, no identity | **沿用**, with one addition | `mesh-engine.ts:18-24`; the note predates `delivered?: string[]` (dedupe window), which is transport state, not identity |
| 9.3 | Discovery filters to one actor type, so other Rivet actor kinds never appear | **沿用** | `mesh-engine.ts:475-483` (`GET /actors?name=xfer-instance`) |
| 9.4 | Sends go through `queueSend` / `sendMeshHandoff` with a 30 s timeout | **沿用** | `mesh-engine.ts:300-310`, `mesh-engine.ts:332-349`, `QUEUE_SEND_TIMEOUT_MS` at `mesh-engine.ts:188` |
| 9.5 | A missing/foreign target used to fail only after 30 s with "target may be offline or stuck" | **本次复核推翻（已修复）** | That text is gone. A 6 s pre-send check now distinguishes "no such node" / "no Runner in its pool" / "engine did not answer" before enqueue (`mesh-engine.ts:510, 563-604`), and the enqueue triages failures by engine code into `not-delivered` / `unknown` / `failed` (`mesh-engine.ts:652-661`). The *original* underlying ambiguity (a timed-out enqueue may still deliver) survives on purpose as `unknown` |
| 9.6 | `up()` refuses a `Running` same-name actor and adopts the rest; `down()` is the only destroy path | **沿用** | `mesh.ts:163-173` (refuse on `Running`), `mesh.ts:197-215` (destroy only in `down()`), ADR 0016. **Exception found**: the admin console also destroys actors, including one `Running` on another host (`admin-main.ts:793-831`) — so "`down()` is the only destroying path" was true of the classes, not of the binaries |
| 9.7 | A pre-send probe must not disturb the target's durable state or queue | **沿用 (as a constraint), now satisfied** | `getDescription` is a pure read action (`mesh-engine.ts:80-82`); `preflightMeshSend` only does two GETs (`mesh-engine.ts:461-483`) |
| 9.8 | "Not checked: whether a `getDescription` probe on a foreign `xfer-instance` actor can be distinguished from a plain offline target" | **本次复核：仍是未检查项** | The shape is now distinguishable *by surface*, not by identity: the actor-probe path (`getDescription`) has no error taxonomy at all and degrades to `undefined` (`mesh-describer.ts:31-35`), while the listing path has the verdict vocabulary and an explicit `Unknown` for "engine did not answer" (`mesh-engine.ts:429-441`). Neither can say "this is not a pi-xfer node" |
| 9.9 | No repo doc covers this trust boundary; a decision needs an ADR | **本次复核推翻** | `docs/adr/0019-mesh-transport-security.md` (accepted) now covers it: peer identity is type+key, impersonation is an **accepted** risk with a deployment-level mitigation only (ADR 0019:41-43, 84-86) |

The three "hardening options" in the old note's §"加固选项" should be read in this light: option 2
(send-time probe) is now largely implemented as the preflight (§6.6); option 1 (a protocol marker in
actor state) was **not** implemented, and ADR 0019 records that no successor is planned; option 3
(namespace/token isolation) remains a deployment duty, not code.

---

## 10. What is not determinable today (the capability ceiling)

1. **"Is the peer who it says it is"** — on no transport. Local: no binding between frame and socket
   owner (§4). Mesh: no credential below the namespace-wide token (§8.1). Adapterd: inherits both
   (§5).
2. **"Is this name taken by a live process"** — locally unknowable without a probe, and the probe
   cannot tell *which* process answered (§6.7). `/xfer list` will happily show a stolen name once.
3. **"Did the target read it"** — local ack means `deliver()` returned (`server.ts:35-40`); mesh ack
   means the queue accepted, and the dedupe window is recorded right after `onHandoff` returns, before
   the agent has done anything (`mesh-engine.ts:248-249`; `docs/guides/cf-serverless-node.md:81-83`);
   `xfer_to` / `xfer_mesh_to` return the constant `status: "sent"` (`index.ts:194`, `index.ts:191`).
   Carried forward from `notes-reason-network-wake.md` §8.3/§9.2 — still true.
4. **"Is the capability note current / whose is it"** — the description belongs to an actor key, and
   adoption transfers it (§3.1, §7.3); the local copy and the mesh copy are two writes, never
   reconciled (§7.1).
5. **"Who is on this machine right now"** — `listTargets` drops `kind`/`host` (`targets.ts:8-12`), so
   a picker user cannot tell a pi session from an Adapter Daemon; the only in-repo reader that keeps
   `kind` is the skill wrapper's private scan `skills/xfer/scripts/xfer:85-102`.
6. **"Is the pool's Runner on the machine I think it is"** — a pool is a set of Runners with
   self-assigned names (`mesh-engine.ts:424-426`); nothing ties a pool name to a host identity.
7. **"Which segment of a multi-segment actor key is the node"** — `[0]` only, silently
   (`mesh-engine.ts:491`).
8. **"Is a Handoff sitting undelivered in a queue"** — not on any surface (§6.4, §6.5).

---

## Open questions (for the human node; no recommendation attached)

- Q1. The local transport unlinks a live peer's socket on a name collision (§3.2). ADR 0013's
  "refuse rather than auto-rename" was decided for the Mesh. Is the local behaviour a settled
  decision that was never written down, or an unexamined default?
- Q2. `kind`/`host`/`inbox` are written into local metadata by the adapterd but dropped by
  `TargetInfo`. Is "the transport is opaque to the consumer" intentional, or does `TargetInfo` simply
  predate ADR 0015?
- Q3. `README.md:38` says routing stays with the consumer, and `mesh.ts:217-220` keeps listings
  names-only. But the *only* place a description is actually consumed is the web picker — i.e. the
  consumer is a human in a browser, not an agent. Is that the intended shape?
- Q4. No surface shows a verdict and a description together (§7.4). Is the split intentional
  (CLI = liveness, picker = capability) or an accident of two read paths growing separately?
- Q5. `MeshNode.send()` always pays a preflight even though `up()` already proved the node online
  (§6.6) — the `verified` seam exists. Is the extra round deliberate (a target can vanish after
  `up`), or is it an unimplemented optimisation?
- Q6. `docs/guides/mesh-setup.md:104` still calls E2EE "an open candidate item", while ADR 0019
  records P1-C as **declined** and `docs/adr/0019-…:81-83` says there is no planned successor. Two
  documents disagree about whether application-layer encryption is still on the table.
- Q7. `skills/xfer/SKILL.md:36` advertises a "durable `descriptions.json` store"; no `*.ts` in this
  repo writes one (`skills/xfer/scripts/xfer:62-71` reads it). Is the wrapper ahead of the
  implementation, or is the store meant to be written by something outside this repo?
- Q8. The broker's WebSocket accepts any page on this machine with no `Origin` check
  (`ws-server.ts:186-204`) and can submit a Handoff as `web-picker` (§8.3). Localhost-trust is the
  stated model (`broker-main.ts:818-823`); the consequence for *cross-origin* local pages is not
  stated anywhere.
- Q9. Adoption transfers the previous holder's `description` (§3.1). ADR 0016 says durable state is
  preserved deliberately. Is a transferred capability claim (rather than transferred queue/dedupe
  state) part of what was intended?
- Q10. `descriptions.json` aside, `/xfer desc` caps at 500 chars on the Mesh path only (§7.1), so a
  long local description is a guaranteed mesh-sync failure. Should the local write path share the
  bound, or should the mesh path accept whatever the local one holds?

---

## 核对与存疑 (verification notes, and where this file is uncertain)

**What was verified by reading source only.** Every `file.ts:line` above was read at `ae1121c`. No
test was run except `git log`/`git diff` for the archive date; no engine, no `~/.pi/xfer`, no live
deployment was touched, and `XFER_ALLOW_REMOTE` was not set.

**Deliberately not claimed (uncertain):**

- **`decodeURIComponent` over-wide input.** `utils.ts:114-116` decodes *every* `.sock` stem on the way
  into a listing, and any string that happens to be valid percent-encoding gets decoded — a foreign
  file named `%41.sock` lists as peer `A`. `endpointForName("A")` then points at `A.sock`, not at
  `%41.sock`. I did not test whether the engine or any other tool creates such names; recorded as a
  reading of the code, not as an observed failure.
- **Actor `Running` vs a Runner in another pool.** `assertPoolMatch` (`mesh.ts:279-290`) is reached
  only when the actor is *not* `Running` (`mesh.ts:164-173`), because the `Running` branch throws
  first. I did not probe whether a `Running` actor in a foreign pool is a real state; the ordering
  reading is from source.
- **Key serialization parity.** `serializeMeshKey`/`deserializeMeshKey` (`mesh-config.ts:410-439`)
  are documented as mirroring the engine for "the shapes mesh keys use (non-empty string parts)"
  (`mesh-config.ts:405-409`); an empty-name or two-segment key case is representable but never
  exercised here, so the round trip for those is unverified, not claimed broken.
- **Engine listing semantics.** The claim that an actor in another *pool* still appears in this
  host's `/actors` listing comes from the comment at `mesh-engine.ts:265-266` ("`get`/list stay
  un-pooled") and from `mesh-engine.ts:475-483`, which sends no pool filter — not from an engine
  observation in this session. `docs/guides/cf-serverless-node.md:102-103` qualifies this for serverless pools specifically (a serverless pool "holds no runner of its
  own"), which is a different axis (pool kind, not list membership).
- The previous note's §9.8 question ("can a `getDescription` probe distinguish a foreign actor from
  an offline one") **remains unverified**: what a foreign `xfer-instance` actor returns from
  `getDescription` was not observed, and cannot be observed hermetically. What §9.8 *does* record is
  the weaker, code-level fact that the two *surfaces* differ — the probe path has no error taxonomy
  (`mesh-describer.ts:31-35`) while the listing path has an explicit `Unknown` (`mesh-engine.ts:433`) —
  and neither has a "not a pi-xfer node" verdict.

**Where this file leans on a document rather than code:** §8.1's subprotocol/URL token carriers are
ADR 0019's measurements (`docs/adr/0019-mesh-transport-security.md:36-40`) and
`notes-mesh-transport-encryption.md` §2-3; `mesh-engine.ts` only shows the `Authorization` header
(`mesh-engine.ts:358`) and the `setup({ token })` pass-through (`mesh-engine.ts:249`). The rest of
the token's journey is inside rivetkit, which is not in this repo's source.
