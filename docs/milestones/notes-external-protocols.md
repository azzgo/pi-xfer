# External agent↔agent protocol landscape — research input (survey + ADR compatibility)
[简体中文](notes-external-protocols.zh.md)

Provenance: read-only survey by a pi session on `ison-arch`, project `pi-xfer`, branch `main`,
2026-10-18. No code changed; the only file written is this note. No live deployment was contacted
and `XFER_ALLOW_REMOTE` was never set. External claims carry a URL; repo claims carry `file:line`.
Direct HTTP fetches of `a2a-protocol.org`, `modelcontextprotocol.io`, `c2c.im` and
`reasonmachines.com` were blocked by the local SSRF guard (they resolve into `198.18.0.0/15`), so
those sources were read through the search provider's extracted page content instead — the URLs
below are the pages that content came from, not pages this session loaded itself. See §10.

The task was a map, not a recommendation. **No project is recommended, ranked, or preferred here.**
Section 9 separates documented fact from my inference; section 10 lists what could not be checked.

---

## 0. How the landscape splits

Six families showed up. They differ along one axis that matters more than any other: **who is
allowed to be the address of a message.** A service, a session, a task, or a machine.

| Family | Representative | Address unit | What it actually solves |
|---|---|---|---|
| **Task-delegation standards** | A2A | a *remote agent service* at a URL | cross-vendor task delegation with a lifecycle |
| **Tool-invocation protocols** | MCP | a *tool* on a server | agent→capability, not agent→agent |
| **Transport layers under the above** | AGNTCY SLIM | a *named endpoint* (DID) | pub/sub + RPC + group encryption as a substrate |
| **Local coding-agent meshes** | Reason Network, c2c.im, agents-mesh | a *live session* | "tell the other agent in the other window" |
| **Host-native session messaging** | Claude Code cross-session socket, Codex app-server | a *session on this machine* | vendor-internal session↔session delivery |
| **Agent gateways / meshes** | agentgateway, Agent Mesh | a *published service name* | governance, identity, policy, observability |

pi-xfer's own shape — a document handed to a named peer, point-to-point, no lifecycle — is closest
to the fourth row and does not resemble rows one or three. That is a fact about the map, not a
judgement about which row is better.

---

## 1. A2A (Agent2Agent)

**Problem it solves:** let an agent built on one framework/vendor delegate a *task* to an agent
built on another, across organizational boundaries, without sharing memory.
(<https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/>)

**Message model.** Explicitly not one-way. A client sends a `Message` (role + `Parts`) and the
remote agent responds with either a stateless `Message` or a stateful `Task`. A `Task` carries
`id`, optional `contextId`, `status`, `artifacts`, `history` and progresses through
`submitted → working → (input-required | auth-required) → completed | failed | canceled |
rejected`, and **terminal states are immutable** — a refinement starts a new `Task` in the same
`contextId`. (<https://a2a-protocol.org/latest/topics/life-of-a-task/>,
<https://a2a-protocol.org/latest/specification/>)

Three update-delivery mechanisms exist: **polling** `GetTask`, **SSE streaming** via
`SendStreamingMessage` / `SubscribeToTask`, and **push notifications** — server-initiated HTTP POST
to a client-supplied webhook for long-running or disconnected cases.
(<https://a2a-protocol.org/latest/topics/streaming-and-async/>,
<https://a2a-protocol.org/latest/specification/>)

**Is there an explicit delivered/seen distinction?** Not as a message receipt. The protocol models
*progress*, not *attention*: `submitted` means the server acknowledged, `working` means it is
processing. There is no "the agent read it" state, because in A2A the server *is* the agent — an
acknowledging server has by construction already handed the work to a process. Documented; my
reading of why the distinction is absent is inference (§9).

**Identity and discovery.** The **Agent Card**: a JSON document with `name`, `description`, required
`supportedInterfaces` (ordered, first preferred), `version`, `capabilities`, `securitySchemes`,
`defaultInputModes`/`defaultOutputModes`, `skills`, and optional `signatures` (JSON Web Signatures
over the card). (<https://a2a-protocol.org/latest/specification/>) v1.0 added **Signed Agent Cards**
for cryptographic identity verification.
(<https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year>)
Discovery is web-shaped: you must know the agent's URL to fetch its card. A registry is on the
roadmap, not in the spec — third-party commentary lists "no registry" as the standing gap
(<https://the-ai-alliance.github.io/enterprise-MCP/getting-to-know-mcp/mcp-and-everyone-else/>).

**Cost to adopt in pi-xfer.** An A2A *server* is an HTTP endpoint with SSE and/or webhook callbacks;
an A2A *client* fetches a card over HTTPS and posts JSON-RPC. Neither is a local-socket shape. A pi
session is not addressable at a URL and has no `Task` lifecycle. Making pi-xfer speak A2A would mean
adding an inbound HTTP listener and a task store — three things ADR 0013 chose against
(`docs/adr/0013-xfer-mesh-rivetkit-transport.md`: in-process, no separate daemon; "上线单元 = 连接单元").

**Maturity.** Linux Foundation–hosted since 2025-06-23
(<https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents>),
v1.0 stable, 150+ organizations claimed, native support in Azure AI Foundry, Copilot Studio and
Bedrock AgentCore Runtime, five production SDK languages
(<https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year>),
and moved under the Agentic AI Foundation alongside MCP
(<https://a2a-protocol.org/latest/blog/2026/08/27/a-new-chapter-for-a2a-joining-the-agentic-ai-foundation/>).
Note the vendor-support counts on partner pages are **claims by the project**, and a third-party
tracker scores it lower (51 of 265 vendors with own-docs evidence,
<https://standards.fru.dev/standards/a2a>) — the gap between the two is itself data.

---

## 2. MCP, in the communication direction

**Problem it solves:** connect an agent (host/client) to *capabilities* — tools, resources,
prompts — exposed by *servers*. (<https://modelcontextprotocol.io/specification/2025-06-18>)

**The server→client direction.** Three client features exist and none of them is "send this agent a
message":

- **Sampling** — server asks the client to run an LLM completion. **Deprecated as of protocol
  version `2026-07-28`, scheduled for removal**; new implementations are told to call provider APIs
  directly. (<https://modelcontextprotocol.io/docs/draft/learn/client-concepts>)
- **Elicitation** — server asks the *user* for input, form mode or URL mode; clients must declare
  the `elicitation` capability.
  (<https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation>)
- **Roots** — also deprecated in `2026-07-28`.
  (<https://modelcontextprotocol.io/docs/draft/learn/client-concepts>)

Critically, **server-initiated requests are no longer standalone**. SEP-2260 (status Final)
requires `roots/list`, `sampling/createMessage` and `elicitation/create` to be *associated with an
originating client-to-server request*; the old server-initiated pattern "is no longer supported.
This is a breaking change," replaced by Multi Round-Trip Requests
(<https://modelcontextprotocol.io/seps/2260-Require-Server-requests-to-be-associated-with-Client-requests>,
<https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr>).

**Why it is usually read as agent→tool, not agent→agent.** Two documented reasons and one
structural one:

1. MRTR makes server→client an *interstitial step inside a client's own request*, not an
   unsolicited push. An agent can only be reached while it is already calling that server.
2. The spec's own `NOTIFICATIONS` are one-way and the receiver MUST NOT respond; they are not a
   conversation.
   (<https://modelcontextprotocol.io/specification/2026-07-28/basic>)
3. Reason Network states empirically that "**MCP notifications are not a delivery path: no client
   passes them to the model (checked Oct 2026)**" — a claim from the vendor, not the spec
   (quoted in §3 below, from the DESIGN.md text).

Third parties say the same thing normatively: Akka's guidance marks `Agent → MCP Server → Agent` as
⚠️ Avoid, on the grounds that MCP tool calls have "no automatic failover or retry or timeout system"
(<https://doc.akka.io/concepts/inter-agent-comms.html>); a separate essay argues MCP "gives you"
none of lifecycle, discovery, async streaming or mid-task pausing
(<https://nickperkins.au/article/agent-communication-protocol/>). An academic comparison finds MCP
*can* support coordination in constrained systems, i.e. it is possible but not the designed shape
(<https://the-ai-alliance.github.io/enterprise-MCP/getting-to-know-mcp/mcp-and-everyone-else/>).

**Identity and discovery.** Capability negotiation only (`initialize` handshake, client/server
capabilities). No peer identity, no agent directory.

**Cost to adopt.** Effectively zero in one direction, and that is the trap: pi-xfer *already* ships
`xfer_to` as a tool (MCP-shaped in pi, `index.ts:73-95`), so an MCP server that wraps it looks
free. But the *inbound* half — reaching a pi session from outside — has no MCP path per the above.

**Relevance to pi-xfer's own history:** Reason Network ships `reason-network mcp` as a stdio MCP
server that is a *thin client of a local daemon*, i.e. it uses MCP as a tool surface for a transport
that lives elsewhere (see §3). c2c.im does the same with `c2c-mcp-server`, explicitly opt-in
(`--with-mcp`) and never the guaranteed wake path
(<https://c2c.im/architecture/>). Both treat MCP as the *front door*, never the wire.

---

## 3. Reason Network — and a check of the earlier note

Sources: `reason-machines/reason-network` `DESIGN.md`
(<https://raw.githubusercontent.com/reason-machines/reason-network/main/DESIGN.md>), read in full
this session; plus `docs/milestones/notes-reason-network-wake.md` for the transcription under test.

**Problem it solves:** "a team directory of live sessions with context (person, machine, agent,
repo, branch, busy/idle, what it is doing), so an agent can pick the right recipient instead of
broadcasting and hoping. That is the core of this project; **messaging is the easy part**."
(DESIGN.md, same URL)

**Message model.** `Envelope{id: ulid, from, to, reply_to, thread, body, sent_at}`, sent directly to
each target machine over iroh QUIC on ALPN `tincan/1`, length-prefixed JSON. Receiver persists then
acks `stored | delivered | held | refused`; later `delivered` / `read` receipts flow back; sender
keeps an outbox and retries. Addresses are per-session (`alice/api-cursor`), with a per-machine
qualifier (`@xps`); group addresses (`alice/*`, `repo:acme/api`, `*`) exist but are **refused for
agent senders** — only a `<person>/terminal` sender may use them, "so it picks one session."

**Delivered vs seen — yes, explicitly.** This is the one design in the survey with a receipt
vocabulary separate from delivery durability, plus a *per-session advertised delivery tier*
(`push` / `turn` / `pull`) so the sender learns *when* the message will be seen. `send` returns
per-recipient state and tier, e.g. "queued: alice/web-cursor is idle and turn-only, it sees this
when alice next prompts it."

**Identity and discovery.** Machine identity = iroh `EndpointId` (ed25519), key at
`~/.reason/network/machine.key`. Membership = a replicated, signed **roster** (`admissions`,
`members`, `invites`, `meta`); no machine can admit itself; a "gate" drops non-members. Presence is
a full mesh of daemons pushing `Presence{machine, seq, sessions[], human_status}` on change.
Passive discovery: it reads `~/.claude/sessions/<pid>.json` so Claude sessions appear (with
busy/idle) even without its MCP server loaded. `doing` is *inferred*, never self-reported
(`doing.rs`, from transcripts and host todo files).

**Cost to adopt.** A single static Rust binary that runs a per-machine daemon (launchd/systemd
user service), plus per-host integration files it *writes into the host's own config* (Claude Code
plugin or MCP+hooks, `~/.codex/config.toml`, `~/.cursor/mcp.json`, `~/.gemini/settings.json`,
opencode plugin, Copilot `mcp-config.json`). Transport is iroh 1.3 — QUIC dialed by public key,
hole punching, mDNS on LAN, HTTPS relay fallback, defaulting to **n0's public relays**.

**Milestone status.** "M0 to M3 are built and tested on macOS (two machines over iroh; real Claude
Code and Codex sessions). **M4 is not started.**" License in DESIGN.md's defaults section is
`MIT OR Apache-2.0` (see §10 on the Apache-2.0-only attribution in the earlier note).

### 3.1 Transcription check against the earlier note

The earlier note's §2 is accurate on all the load-bearing mechanics: Envelope fields, `tincan/1`,
persist-then-ack with `stored|delivered|held|refused`, outbox retry, mailbox-under-session-name,
the `accept|hold|refuse` inbound policy, the peer-framing rule, the three-tier table with the same
per-client mechanisms, and the `serve` description's per-sender threads and warm resume. Six
deviations, all of them overstatements or omissions rather than errors of fact:

1. **License.** The note says "Apache 2.0" (§ header and §6). DESIGN.md attributes it as
   `MIT OR Apache-2.0`. Legally the difference is real for a would-be reuser.
2. **"`reason network serve claude|codex|grok`"** (§2.3). DESIGN.md has no `serve` subcommand. The
   daemon subcommands are `daemon`, `mcp`, `hook <agent>`, and `who|send|listen|status|init|invite|
   join|setup|doctor`. What `serve` describes in the note — long-lived headless agent, per-sender
   threads, warm continuity — does not appear in DESIGN.md at all. Either it lives in docs the note
   cites separately (`docs.reasonmachines.com/docs/network`) or the note conflated it with `listen`
   /`wait`. **This is the largest claim in the note that the primary design doc does not support.**
3. **"`codex queue --thread`"** (§2.2). DESIGN.md says `` `codex queue --thread <id>` / app-server
   `turn/start` `` — same thing, but the note presents it as the primary mechanism while DESIGN.md
   lists it first for Codex *push* alongside hooks. No contradiction, just compression.
4. **Scope of the pty-injection path** (§2.4.3). The note gives it as Reason's "激进的补充路径" with
   tmux/herdr detection. DESIGN.md's own table gives idle fallbacks as *background
   `reason-network wait`* (Cursor), *experimental background-shell inject* (Gemini) and *`asyncRewake`
   hook* (Claude) — it does not describe a tmux-pane nudge. The concept may exist in Reason's
   broader CLI; DESIGN.md does not carry it, and the note's "Reason 自己主推 `serve`" framing
   inherits the §8-2 problem.
5. **Group addressing** (§2.1, §2.4 not mentioned). The note never mentions that group sends
   (`*`, `person/*`, `repo:`) are **refused for agent senders**, nor the loop guard (per-sender rate
   limit + a cap on consecutive agent↔agent messages with no human input). Both are the most
   directly pi-xfer-relevant safety designs in the document, and their absence from the note is an
   omission of the parts most worth comparing.
6. **Maturity.** The note does not record that M4 is not started, nor that testing is macOS-only and
   two-machine. Its "Reason Network" column reads as a shipped product; DESIGN.md reads as M3 of a
   four-milestone project.

One thing the note says that DESIGN.md strengthens rather than weakens: it calls the daemon
"per machine," which is exact — identity is per *machine* (`EndpointId`), and a session is an
address *within* that machine. That distinction matters if pi-xfer ever compares Node to it
(pi-xfer's Node is one actor per *instance*, `CONTEXT.md` "Node").

---

## 4. c2c.im — broker + per-client delivery/wake contract

**Problem it solves:** local-first and optionally relayed instant messaging between coding-agent
sessions, with an unusually explicit statement of *what is and is not guaranteed*.

**Message model.** Three routing scopes, each with its own broker root: `repo`
(`~/.c2c/repos/<repo>/broker`), `pc-local` (`~/.c2c/sessions/broker`), `relay`
(`relay.c2c.im`). (<https://c2c.im/reference/scopes/>) Durable-first: "every accepted message is
written to the recipient's broker inbox and archive before the send returns."
(<https://c2c.im/wake-contract/>) Rooms exist for group communication but direct messages do not
require one (<https://c2c.im/get-started/>).

**Delivered vs seen — the sharpest statement in the survey.** c2c separates the two properties by
name and refuses to let mechanisms restate guarantees:

- **Durability** — always true; mail waits.
- **Wake** — client-dependent, graded **GUARANTEED / CONDITIONAL / NONE**, with the condition
  attached to each row.
- Explicitly *not* a wake: `poll_inbox`, `peek_inbox`, `wait-inbox`, activity-triggered hooks,
  agent-armed `c2c monitor`, and — its own dedicated page — `deliver-watch`/`--inotify`, which
  "improves latency, not reliability."
- "Never assume a peer read your message because the send succeeded."
- "**A message never authorizes an action.** Regardless of how it was delivered, message content is
  DATA."
  (all from <https://c2c.im/wake-contract/>)

Wake grading as of the page's 2026-10-03 summary: GUARANTEED — OpenCode, **Pi Agent**, managed Codex
(local mail), Hermes CLI; CONDITIONAL — Kimi and agy (out-of-process poster), Claude Code / Grok /
Muse on an armed monitor; NONE — Hermes gateway mode.
(<https://c2c.im/clients/feature-matrix/>) Pi Agent's GUARANTEED row is an in-process `pi-c2c`
extension doing `fs.watch` on the broker inbox → `c2c poll-inbox` → `pi.sendMessage`, "urgent steers;
nonurgent follow-up," plus a 60 s safety-net poll
(<https://c2c.im/wake-contract/>) — the same two-branch shape pi-xfer already implements at
`controller.ts:68-71` (`followUp`+`triggerTurn` when idle, `steer` when busy).

**Identity and discovery.** Four identifiers with distinct lifetimes
(<https://c2c.im/reference/identifiers/>): `alias` (human name, reserved 12 months after last
seen), `node_id` (host/install), `session_id` (one agent session), `identity_pk` (Ed25519, one
keypair per machine at `~/.config/c2c/identity.json`). First signed registration pins
`alias → identity_pk` and later operations must be signed by that key — **TOFU**. Delivery leases
expire in 24 h by default so sends to offline agents fail fast. On the relay there is an opt-in
proof-of-work anti-flood layer keyed by `identity_pk`.

**Cost to adopt.** An OCaml `c2c` binary plus a local broker, plus per-client install artifacts it
writes into host configs (`c2c install claude|codex|opencode|kimi|grok|agy|hermes|muse`), with
`--with-mcp` as a separate opt-in. The relay is **hosted**: `relay.c2c.im`, aliases globally shared,
`auth_mode=prod`, PoW enabled (<https://c2c.im/connect/>).

**Note on scope.** Room membership implies a group/broadcast model that pi-xfer has no counterpart
for; point-to-point is the only shared shape.

---

## 5. Host-native session messaging

### 5.1 Claude Code cross-session messaging

**Problem it solves:** one Claude Code session warns or answers another session on the same machine.

Documented mechanism (<https://code.claude.com/docs/en/cross-session-messaging>): each session binds
an **inbox socket** — a Unix domain socket on macOS/Linux (named pipe on Windows) — path exported as
`CLAUDE_CODE_MESSAGING_SOCKET`, plus a per-session `CLAUDE_CODE_MESSAGING_TOKEN`. Socket lives under
`$XDG_RUNTIME_DIR/cc-socks/`, dir 0700, socket 0600; falls back to `/tmp` when the path would exceed
the 103-byte socket limit; non-local paths are refused outright and a live socket is never hijacked
(<https://changelogs.core-directive.com/v/2.1.224/e/local-messaging-socket-where-it-lives-who-can-read-it-and-re>).
Line-delimited JSON, lines over 1 MiB dropped.

**Identity/discovery.** OS-user scoping (socket restricted to your user; Windows uses the token
instead). Not a directory — you must already know or be given the path. Same-machine messages "never
through Anthropic servers"; other-machine and cloud sessions **do** route through Anthropic servers.

**Delivered vs seen.** No receipt. There is instead an **inbound control**: `crossSessionInbound`
= `accept` | `hold` | `refuse`, plus `dialogExpiry` for how long a held message stays held. There are
anti-loop guards — a per-sender limit, identical-repeat suppression, at most 50 queued messages.

**Cost to adopt.** Low and adversarial at the same time: writing a line of JSON to a known socket
path is trivial, but it is an *undocumented-for-third-parties* surface, has no capability listing,
and is version-gated (v2.1.224+/v2.1.248+ depending on provider). pi-xfer could *address* a Claude
session this way if it learned the path; it could not be *discovered* this way.

### 5.2 Codex app-server

**Problem it solves:** a JSON-RPC control surface so an external program can drive a Codex agent.

From the Codex source types
(<https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/src/protocol/v1.rs>,
as returned by the search provider): `InitializeParams{client_info}`, `NewConversationParams{model,
cwd, approval_policy, sandbox, config, base_instructions, …}` → `NewConversationResponse{
conversation_id, model, rollout_path}`, plus `ResumeConversationParams`, `ListConversationsParams`,
`AddConversationSubscriptionResponse{subscription_id}`, `ArchiveConversationParams`, and
human-approval round-trips (`ApplyPatchApprovalParams/Response`, `ExecCommandApprovalParams/
Response`). That is: conversations are **created and driven by an external supervisor**, and
approvals are a first-class request/response.

**Message model.** Request/response plus subscription, not peer messaging. There is no "peer"
concept — the client is a *controller*, not a colleague.

**Identity and discovery.** `conversation_id`; client identifies itself via `client_info`.

**Cost to adopt.** A JSON-RPC client over the app-server transport. c2c.im reports using
`thread/inject_items` on arrival plus "one gated auto-turn (thread idle, DND off)" as its Codex
GUARANTEED path, and failing closed to inject-only for remote senders
(<https://c2c.im/wake-contract/>) — i.e. the *gating is theirs*, not Codex's.

---

## 6. Community meshes and gateways

### 6.1 agents-mesh (localhost broker)

A local HTTP broker on `localhost:7899`; each agent auto-registers under an id like
`peer_ac7e701d`, sends heartbeats, then uses natural-language MCP tools: `peers_list`, `peers_ask`
(broker holds the message until the peer calls `peers_check`), `peers_reply`, `peers_notify`
(broadcast). "All on localhost, no cloud, no accounts."
(<https://github.com/agents-mesh/agents-mesh>, content via the project's own site as returned by
search)

**Delivered vs seen.** Implicit: a message is *held* until the peer polls. That is a `queued`/`pull`
model with no receipt vocabulary. Discovery is liveness-only (heartbeats); "what they are working
on" is self-reported.

### 6.2 agentgateway / Agent Mesh

**agentgateway** is an open-source proxy covering agent-to-LLM, agent-to-tool and **agent-to-agent**
(A2A) traffic, with JWT/API-key/OAuth auth, RBAC via a CEL policy engine, rate limiting, TLS,
OpenTelemetry, and A2A "capability discovery, modality negotiation, task collaboration"
(<https://github.com/agentgateway/agentgateway>, <https://agentgateway.dev/>).

**Google Agent Mesh** is a zero-trust overlay: control plane verifying OIDC/bootstrap tokens and
issuing short-lived Biscuit credentials, a router running a Kademlia DHT and relaying encrypted
streams without seeing plaintext, and a local `agentmesh-node` publishing/calling `mcp://`,
`a2a://`, `inference://`, `egress://` service names. "Nothing is reachable by default"; peers invoke
*published service names*, not open ports (<https://google.github.io/agentmesh/>).

Both are control-plane products. Their unit of address is a service, their value is policy, and
both presuppose an operator who wants policy — a different problem from "two agents on my laptop".

### 6.3 AGNTCY SLIM (transport substrate)

An IETF Internet-Draft (`draft-mpsb-agntcy-slim-02`, 2026-07-07, Informational, no RFC stream):
gRPC-over-HTTP/2 and /3 thin waist, MLS end-to-end encryption at the content layer, hierarchical
DID-based names (`organization/namespace/service/instance`), pub/sub + group sessions + SRPC
streaming RPC, split into data/session/control planes
(<https://datatracker.ietf.org/doc/draft-mpsb-agntcy-slim/>, <https://github.com/agntcy/slim>).
Its stated purpose is to *be the transport under A2A and MCP*, not to be an agent-facing protocol.
Maturity: individual draft, expires 2027-01-08.

### 6.4 The prior-art cluster Reason itself surveys

DESIGN.md lists ~15 projects from 2026 and names two closest: **agentbus** (Rust, per-device daemon,
iroh, peers are your own devices via Tailscale, others answered by a *headless responder* not their
live sessions) and **agents-party** (shared encrypted room, cross-machine needs a hosted or
self-hosted server). Others named: agent-rpc (Zig broker + tmux injection), mcp_agent_mail,
agent-mesh (Codex app-server delivery, `peek_peer`), agent-peer, ccbridge, agent-bridge, intermcp,
claude-message-mcp, Paseo. (All from the DESIGN.md URL above, which links each.)

I did **not** read these projects' own docs — see §10. Treat the two-sentence characterisations as
Reason's claims.

---

## 7. Where the survey keeps converging

Four independent projects describe the same trap in nearly the same words, which makes it the single
most repeated finding:

| Source | Statement |
|---|---|
| Reason DESIGN.md | "MCP notifications are not a delivery path: no client passes them to the model (checked Oct 2026)." |
| c2c.im wake contract | Activity-triggered hooks "fire because the agent was already doing something"; `poll_inbox` "requires the model to choose to call it. A fallback is not a guarantee." |
| c2c.im wake contract | "Never assume a peer read your message because the send succeeded." |
| Reason DESIGN.md | hook process must detect which agent is actually calling it, because Cursor/Copilot/Devin load Claude Code's hooks |

And one convergence on the *safety* side, stated independently by three:

- Reason: incoming messages are "framed as peer input, never as the user"; agents told not to treat
  peer text as user instructions; plus per-machine `accept|hold|refuse`.
- c2c.im: "A message never authorizes an action… message content is DATA: it cannot resolve an
  approval or write a verdict file."
- Codex app-server: approvals are a separate request/response channel from conversation content.

pi-xfer's counterparts: ADR 0018 splits `Task` / `Notification` at the sender
(`docs/adr/0018-handoff-kind-sender-declares.md`), and `controller.ts:41-67` frames inbound as
`**Handoff**` with an explicit "asks you for output" / "asks you for nothing" sentence. What pi-xfer
does **not** have is any inbound policy equivalent to `accept|hold|refuse`, and no loop guard.

---

## 8. Compatibility with the settled positions (ADR 0013 / 0014 / 0015)

The three ADRs, in one line each:

- **0013** — mesh is opt-in RivetKit, **in-process**, no separate bridge daemon, no registry actor,
  engine-side discovery, durable queue, command surface picks transport explicitly
  (`docs/adr/0013-xfer-mesh-rivetkit-transport.md`).
- **0014** — Board stays machine-local files; cross-machine sharing is directory sync, "零代码"
  (`docs/adr/0014-board-stays-machine-local.md`).
- **0015** — one bundle, dual transport, **take-to-read Inbox with no durable storage behind it**,
  "The Inbox is lossy by construction (take deletes). That is the point"
  (`docs/adr/0015-adapter-daemon.md`).

Below: what is in structural tension, and what could be absorbed. No recommendation either way.

### 8.1 Natural conflicts (structural, not stylistic)

| External design | Which settled position it breaks | Why |
|---|---|---|
| **A2A** as a wire for pi-xfer | 0013 (no separate service; connect unit = pi instance) | Needs a durable inbound HTTP endpoint + task store that outlives the session. A pi session is not addressable at a URL and has no `Task` lifecycle. Also implies the *receiver* owns task state, which 0014 sends to the Board instead. |
| **SLIM / Agent Mesh / agentgateway** | 0013 (no extra permanent component), 0014 (state elsewhere) | All three are control-plane-plus-router deployments. Agent Mesh explicitly centralises identity and policy; agentgateway is a proxy in the data path. 0013 rejected "独立 bridge daemon" and a registry actor for the same class of reason. |
| **c2c.im's hosted relay** (`relay.c2c.im`, global aliases, PoW, leases) | 0013 (engine is the operator's own; discovery = engine `listActors`), 0019 (identity admitted as weak) | A third-party relay is a *second* discovery authority and a shared global namespace. 0019 already records that peer identity is "actor type name plus a key. No handshake, no credential" and calls impersonation accepted — adding a global alias registry does not fix that; it moves it. |
| **Reason Network's signed roster** | 0013's discovery decision; 0014's "no lifecycle" | Membership is replicated, signed, with admissions/invites/removal and a convergence story. That is a second source of truth about who exists, competing with "引擎调度状态即注册表". Also implies state with a lifecycle and a cleanup story, which the Board deliberately refuses (`CONTEXT.md` "Card": "no lifecycle statuses"). |
| **Durable mailbox / archive** (c2c archive, Reason's mailbox + outbox, A2A `Task.history`) | 0015 (Inbox is deliberately lossy, take-to-read, no durable storage) | 0015 chose "deliver into the session, not a durable mailbox" and recorded a persistent mailbox as *considered and rejected*. Anything with a `delivered`/`read` receipt stream implies a store that outlives the read. |
| **Server-side wake guarantees** (c2c's GUARANTEED tier shipped as a broker promise) | 0013 (crash policy sleep ⇒ offline is normal) | A guarantee made by a central party about another party's process is exactly the "daemon 活着但 pi 死了" ambiguity 0013 avoided by making the connection unit the pi instance. |
| **Agent Card as discovery** | 0013 (discovery is `listActors`) | Capability declaration is already carried by the Node's self-declared description on the actor (`mesh-engine.ts:19-20`), and README calls it "Unverified self-declaration — routing stays with the consumer". An Agent Card is the same claim in a heavier, signed form. |

### 8.2 What is absorbable without touching an ADR

These are *facts about compatibility*; they are not proposals.

1. **Per-recipient delivery verdict vocabulary.** Reason's `stored|delivered|held|refused` and
   c2c's durability-vs-wake split both live entirely in the *sender's* return value. pi-xfer's
   `xfer_to` / `xfer_mesh_to` output schemas (`index.ts:90-95`, `index.ts:171-175`) and the constant
   `status: "sent"` (`index.ts:149`, `index.ts:194`) are the exact seam, and the idle/busy branch
   that would supply the value already exists at `controller.ts:68-71`. Nothing about a verdict
   requires a server, a registry or persistence — the prior note reached the same conclusion in its
   §9.2 and §8.3.
2. **Peer-input framing.** Already implemented (`controller.ts:44-67`); Reason's and c2c.im's
   statements are independent corroboration that the framing rule is load-bearing, not cosmetic.
3. **Local socket + `--on-handoff` event delivery.** This is pi-xfer's existing answer to the
   problem Reason solves with tiers and c2c solves with per-client integrations
   (`adapterd.src/daemon.ts:110-121` spawn). Both external projects confirm that in-process or
   event-triggered delivery is the only path that holds without a model decision — c2c.im's Pi row
   is literally an in-process extension doing what `controller.ts` does.
4. **A `hold`/`refuse` inbound policy.** *Not* present in pi-xfer. Reason has it per-machine,
   Claude Code has it per-session (`crossSessionInbound`). It is a local file or a setting, so it does
   not conflict with 0013/0014 — but it is new surface, and 0018's "the sender declares, the
   receiver never judges" is about *kind*, not about *acceptance*, so the two do not collide. Whether
   pi-xfer wants it is a product question, not a compatibility one.
5. **Loop guard.** *Not* present. Reason's "cap on consecutive agent↔agent messages in a thread
   without any human input" and Claude Code's per-sender limit + 50-message queue are both local,
   stateless-ish counters. No ADR stands in the way; none exists today.

---

## 9. Documented vs inferred

**Documented (URL or `file:line` above).** All of §1–§7's mechanics; all of §8.1's ADR positions;
the repo state quoted in §8.2 items 1–3.

**Inference — mine, not the projects' words:**

- That A2A lacks a "seen" state *because* the server is the agent (§1). The spec documents the
  absence of such a state and documents `TaskState`; it does not explain the absence.
- The reading of §8.1's "natural conflict" column as *structural*. No external project says it
  conflicts with pi-xfer; the mapping to 0013/0014/0015 is mine.
- Ranking the absence of a `hold`/`refuse` policy and of a loop guard as the two most comparable
  omissions (§8.2 items 4–5). Both external projects consider them necessary; pi-xfer has not
  recorded a position.
- The claim that `controller.ts:68-71`'s branch supplies exactly what a tier verdict needs. That
  is a code-reading judgement, and the earlier note already flags an unresolved internal conflict
  between two busy/idle signals (`state.isRuntimeIdle()` vs `state.currentStatus`) that would have to
  be settled before any verdict is published as a contract.

---

## 10. What I could not check

Recorded so the next reader does not treat this note as more than it is.

1. **Direct page loads were blocked** for `a2a-protocol.org`, `modelcontextprotocol.io`, `c2c.im`
   and `reasonmachines.com` (every one resolved to `198.18.13.x`, inside the SSRF guard's TUN /
   fake-IP range). Content came from the search provider's extraction of those pages. The URLs are
   the pages extracted; they were not fetched by this session.
2. **Reason Network's `serve` subcommand is unverified.** DESIGN.md does not contain it (§3.1 item
   2). I did not read `docs.reasonmachines.com/docs/network`, the repo's code, or its releases. The
   earlier note's §2.3 therefore stands as *possibly correct but unsupported by its own cited
   primary source*.
3. **Reason Network's license** is what DESIGN.md's defaults section says (`MIT OR Apache-2.0`). I
   did not read the `LICENSE` file or the repo metadata, so I cannot say the earlier note's
   "Apache 2.0" is wrong — only that the design doc does not say that.
4. **The ~15 prior-art projects in §6.4 were not read.** Only Reason's two-sentence
   characterisations exist here. `agentbus` is described as having "no license", which I also did
   not verify.
5. **A2A's current schema** was read from `/latest/specification` and `/latest/topics/*`; the
   `TaskState` list also appeared as a v0.2.5 enum. I did not diff v0.2.5 against v1.0, so any
   claim here about A2A should be read as "as of the `latest` pages on 2026-10-18."
6. **MCP versions are mixed on purpose and worth flagging:** `2025-06-18` (features list),
   `2026-07-28` (elicitation, base protocol), `draft` (MRTR). Sampling and roots are deprecated in
   `2026-07-28` per the draft client-concepts page; I did not read the `2026-07-28` changelog
   itself to confirm the deprecation date's exact wording.
7. **Codex app-server** was read from a single `protocol/v1.rs` as returned by search, and the file
   was truncated. Newer `thread/start` / `turn/start` methods that c2c.im and Reason both reference
   were **not** seen in source — only their names, as quoted by those two projects.
8. **Claude Code's socket** is documented by Anthropic for *its own sessions*; I found no statement
   that third-party processes are supported, and no schema doc for the `{"type":"user",…}` frame
   that Reason says it writes. The 1 MiB line cap and 0600/0700 permissions come from a
   third-party release-notes mirror (`changelogs.core-directive.com`), not from Anthropic's page.
9. **No deployment was contacted** and no test was run. Nothing here is a measurement of any live
   system; ADR 0019's own measurements remain the only measured numbers in the repo.

---

## 11. Open questions

Not decisions — questions the map raises and leaves open.

1. **Is "who is allowed to be an address" a decision or an accident?** pi-xfer addresses a named
   Node (`CONTEXT.md` "Node"); Reason addresses a session; A2A addresses a URL. ADR 0013 picks one
   for the mesh. Nothing records why *session-level* addressing was not adopted, yet a session is
   what a human actually means when they say "the other agent."
2. **Where does the `delivered`/`read` vocabulary stop being the sender's business?** Both external
   designs keep it in the return value. If a receipt ever has to *outlive* the send, 0015's
   take-to-read Inbox and 0014's "state belongs to the Board" both bear on where it lives.
3. **Is `hold`/`refuse` an inbound-policy question or a Kind question?** 0018 says the *sender*
   declares Kind and the receiver never judges its own output. A receiver refusing to accept is a
   different judgement — about *admission* rather than *output*. No ADR addresses admission.
4. **Does the loop guard belong to the transport or to the agent?** Reason puts it in the daemon;
   Claude Code puts it in the session's inbound controls. pi-xfer has neither and no recorded
   position.
5. **What does 0014's "human cleans the Board" become when a second party writes to it?** Reason's
   roster, c2c's broker, and A2A's task store all imply cleanup stories that the Board deliberately
   does not have.
6. **Does MCP's deprecation of sampling and roots change the agent→agent story?** The last
   spec-level hooks a server had for reaching *a client's* model are being removed, replaced by
   "integrate directly with LLM provider APIs". If that lands, MCP becomes more purely
   agent→tool, and any future bridge cannot route through it even in principle.

---

## 12. Source index

Coding-agent meshes and directories
- <https://raw.githubusercontent.com/reason-machines/reason-network/main/DESIGN.md>
- <https://c2c.im/> · <https://c2c.im/wake-contract/> · <https://c2c.im/client-delivery/> ·
  <https://c2c.im/clients/feature-matrix/> · <https://c2c.im/architecture/> ·
  <https://c2c.im/communication-tiers/> · <https://c2c.im/reference/identifiers/> ·
  <https://c2c.im/reference/scopes/> · <https://c2c.im/get-started/> · <https://c2c.im/connect/> ·
  <https://c2c.im/commands/>
- <https://github.com/agents-mesh/agents-mesh>

Standards
- <https://a2a-protocol.org/latest/specification/> · <https://a2a-protocol.org/latest/topics/life-of-a-task/> ·
  <https://a2a-protocol.org/latest/topics/streaming-and-async/> ·
  <https://a2a-protocol.org/latest/topics/key-concepts/> ·
  <https://a2a-protocol.org/latest/partners/> ·
  <https://a2a-protocol.org/latest/blog/2026/08/27/a-new-chapter-for-a2a-joining-the-agentic-ai-foundation/>
- <https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/>
- <https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents>
- <https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year>
- <https://opensource.googleblog.com/2026/04/a-year-of-open-collaboration-celebrating-the-anniversary-of-a2a.html>
- <https://standards.fru.dev/standards/a2a>
- <https://modelcontextprotocol.io/specification/2025-06-18> ·
  <https://modelcontextprotocol.io/specification/2026-07-28/basic> ·
  <https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation> ·
  <https://modelcontextprotocol.io/docs/draft/learn/client-concepts> ·
  <https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr> ·
  <https://modelcontextprotocol.io/seps/2260-Require-Server-requests-to-be-associated-with-Client-requests>
- <https://datatracker.ietf.org/doc/draft-mpsb-agntcy-slim/> · <https://github.com/agntcy/slim> ·
  <https://docs.agntcy.org/>

Host-native
- <https://code.claude.com/docs/en/cross-session-messaging>
- <https://changelogs.core-directive.com/reference/env/claude-code-messaging-socket> ·
  <https://changelogs.core-directive.com/v/2.1.224/e/local-messaging-socket-where-it-lives-who-can-read-it-and-re> ·
  <https://www.turboai.dev/blog/claude-code-env-vars-v2-1-224>
- <https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/src/protocol/v1.rs>

Gateways, substrates, commentary
- <https://github.com/agentgateway/agentgateway> · <https://agentgateway.dev/>
- <https://google.github.io/agentmesh/>
- <https://doc.akka.io/concepts/inter-agent-comms.html>
- <https://nickperkins.au/article/agent-communication-protocol/>
- <https://the-ai-alliance.github.io/enterprise-MCP/getting-to-know-mcp/mcp-and-everyone-else/>

Repo
- `docs/adr/0013-xfer-mesh-rivetkit-transport.md`, `0014-board-stays-machine-local.md`,
  `0015-adapter-daemon.md`, `0018-handoff-kind-sender-declares.md`,
  `0019-mesh-transport-security.md`
- `CONTEXT.md` (Node / Inbox / Handoff / Board / Card / Delivery verdict), `README.md:38`
- `controller.ts:32,41-67,68-71`, `state.ts:73-76`, `targets.ts:8,18`,
  `mesh-engine.ts:18-23`, `adapterd.src/daemon.ts:36-41,110-121`, `constants.ts:16`,
  `index.ts:73-95,149,171-175,194`
- `docs/milestones/notes-reason-network-wake.md` (the note under transcription check)
