# Mesh transport encryption — research finding (no app-layer crypto; TLS is a deployment duty)

Researched 2026-10-17 at the user's request: "does our Rivet-based mesh communication have any
encryption at all? It is deployed on a VPS without SSL — is there a MITM risk?"

Answer up front: **there is no encryption in pi-xfer or in RivetKit's actor transport.** The only
protection available is TLS on the control-plane endpoint, and that is entirely a deployment
decision — an `http://` endpoint means plaintext on the wire. On a VPS without TLS, an on-path
attacker reads the engine admin token and every handoff document in full.

## 1. pi-xfer adds no crypto

Nothing in this repo encrypts, signs, or MACs a handoff. The payload is inline plaintext markdown
by construction: `MeshHandoffMessage` carries `{ id, from, to, summary, document }` and
`mesh.ts:185` puts the whole document in it. There is no key material anywhere in
`mesh-config.ts` / `mesh-engine.ts` / `mesh.ts`.

## 2. RivetKit adds no crypto either

- The word "E2EE" appears in RivetKit's source (`actor-router-consts.ts`: "Params must be in
  headers or in an E2EE part of the request") but it is not an encryption feature — it is a note
  about *where* connection params may be carried. There is no cipher, no key agreement, no
  authenticated envelope in the actor transport.
- Rivet's own architecture page describes the gateway as speaking "**plain HTTP and WebSocket**"
  (`{RIVET_ENDPOINT}/gateway/{actor_id}/{path}`).
- Credentials ride in cleartext-shaped places: the admin token as `Authorization: Bearer …` on the
  REST discovery call (`mesh-engine.ts:291`) and as a WebSocket subprotocol
  (`WS_PROTOCOL_TOKEN` → `rivet_token.<token>`, a header) plus a URL path segment
  (`/gateway/{actorId}@{token}`) on actor traffic. `buildActorGatewayUrl` even carries a comment
  telling callers not to log these URLs because they embed credentials.

## 3. TLS is decided solely by the endpoint scheme — verified

RivetKit never rewrites the scheme: `combineUrlPath` (`chunk-3CZAZIO5.js:1152`) returns
`${baseUrl.protocol}//${baseUrl.host}${fullPath}`, and that string is handed straight to
`new WebSocket(...)`. So `http://` → `ws://` and `https://` → `wss://`, with no upgrade attempt
and no fallback.

Empirically confirmed against the local tree (a `ws` server on `127.0.0.1`):

```
new WebSocket("http://127.0.0.1:6499/gateway/abc")  →  server saw a plaintext (unencrypted) connection
```

`mesh-engine.ts:181` also passes `endpoint`/`namespace`/`token` to `setup({ … runtime: "native" })`,
so the runner registration WebSocket carries the token over the same unencrypted channel.

## 4. The control plane is HTTP-only by design

From Rivet's self-host docs (TLS page): "The control plane speaks **plain HTTP** and expects a
reverse proxy or load balancer in front of it to terminate TLS." The ports page lists `6420` as
API + dashboard + WebSocket traffic, "**Expose publicly: Yes, behind TLS**", and `6421` as
internal-only. The VM/bare-metal guide says plainly: "Port 6420 should not be exposed directly to
the internet. Terminate TLS at NGINX or Caddy and raise the idle timeout to `3600` seconds, or
long-lived WebSockets will be cut."

So an `http://<vps-ip>:6420` endpoint is not a supported topology — it is the dev-shortcut shape.

## 5. What an on-path attacker actually gets

On the user's current VPS-without-TLS setup, an attacker positioned on any hop between a node and
the VPS can:

1. **Steal the engine admin token.** `Authorization: Bearer <token>` on the REST list call;
   `rivet_token.<token>` subprotocol and `@<token>` in the gateway path on actor traffic; the same
   credential in the runner registration. Rivet's docs describe the admin token as "the root
   credential", granting "every operation in every namespace", unscoppable and unrevocable without
   a restart. This is a total compromise of the control plane, not just of xfer.
2. **Read every handoff document** in both directions — the full markdown, which routinely contains
   source code, file paths, and agent instructions.
3. **Rewrite or inject handoffs** (no integrity protection at all), i.e. instruct another agent —
   and via the peer-identity gap recorded in `notes-mesh-peer-identity.md`, impersonate a node,
   answer discovery, or register a same-name `xfer-instance` actor.
4. **Read node names, descriptions, summaries, and queue contents** — handoff documents sit in the
   actor's durable queue on the engine (RocksDB on the VPS) in the same plaintext.

This compounds the existing finding that peer identity is only the actor type name
`xfer-instance` + a key: without TLS there is not even a transport-level assurance that you are
talking to your own engine.

## 6. Two related doc-accuracy issues found while researching

- `docs/guides/mesh-setup.md:35` says the token "may be omitted when the engine is only reachable
  inside a private network — self-hosted engines accept unauthenticated traffic by default". Per
  Rivet's 2026-09-29 changelog ("Unauthenticated access is now off by default"), the engine now
  requires the admin token or a JWT on every request, and
  `auth.insecure_allow_unauthenticated: true` is the opt-out. The guide's statement is only true
  for engines older than that change — it should be version-qualified or dropped.
- The guide offers `http://203.0.113.10:6420` as a first-class example endpoint with no warning.
  Whatever the deployment, that example should carry the "never without a private network or TLS"
  caveat.

## 7. Options (cheapest real protection first)

1. **Put the engine on a private network** — Tailscale / WireGuard, engine reachable only on the
   VPN. This matches Rivet's own "only accessible within private network" guidance and needs no
   DNS, certificate, or reverse proxy. Rivet's docs suggest `tailscale serve` as a one-liner.
2. **Terminate TLS in front of 6420** — Caddy/nginx + Let's Encrypt, and set the WebSocket idle
   timeout to `3600`s (the default 30–60 s cuts long-lived connections and causes reconnect
   storms). Then make every node's `endpoint` `https://…` so RivetKit negotiates `wss://`.
3. **Stop shipping the admin token to every node.** It is the root credential; mint a scoped JWT
   (1 h, one namespace, one grant set) if the engine version supports it. Failing that, treat
   `~/.pi/xfer/mesh.config.json` as a root-credential file (mode 600) and say so in the guide.
4. **Never expose 6420 directly**; redirect 80 → 443 rather than serving the API on it.

Everything below option 1 is code-side hardening of a channel that is unauthenticated by
construction, so it does not remove the need for 1 or 2.

## Sources

- [TLS | Rivet Control Plane Self-Host](https://rivet.dev/docs/deploy/self-host/control-plane/tls/)
- [Ports | Rivet Control Plane Self-Host](https://rivet.dev/docs/deploy/self-host/control-plane/ports/)
- [VM & Bare Metal | Rivet Control Plane Self-Host](https://rivet.dev/docs/deploy/self-host/control-plane/vm/)
- [Production Checklist | Rivet Control Plane Self-Host](https://rivet.dev/docs/deploy/self-host/control-plane/production-checklist/)
- [Configuration | Rivet Control Plane Self-Host](https://rivet.dev/docs/deploy/self-host/control-plane/configuration/)
- [Architecture | Rivet documentation](https://rivet.dev/docs/architecture/)
- [Authentication | Rivet documentation](https://rivet.dev/docs/authentication/)
- [Authentication | Actors Documentation](https://rivet.dev/actors/docs/authentication/)
- [Introducing JWT Authentication for Rivet Actors (2026-09-29)](https://rivet.dev/changelog/2026-09-29-introducing-jwt-authentication-for-rivet-actors/)
- rivetkit 2.3.26 source in `node_modules/rivetkit` (`combineUrlPath`, `buildActorGatewayUrl`,
  `buildWebSocketProtocols`, `common/actor-router-consts.ts`); local plaintext-WebSocket
  reproduction.

## 8. Reference implementation: paseo-relay + Paseo's E2EE overlay

Reviewed `github.com/azzgo/paseo-relay` (v0.5.0, read from a clone) and Paseo's `SECURITY.md` on
the user's question "is this worth borrowing?"

### The relay itself has no crypto

`main.go` imports `crypto/rand` for one thing only: `randomHex` session IDs. There is no cipher, no
key handling, and **no authentication**: `role`, `serverId`, and `connectionId` are caller-supplied
query params, and `registry.get(serverId)` creates a session on demand for any unknown ID. Anyone
who guesses a `serverId` can join as either side. Its security is entirely outsourced to the
endpoints — the relay is a bounded frame forwarder by design, and that is the whole trick.

### The E2EE scheme lives in Paseo, and it is directly portable

From Paseo's `SECURITY.md`:

- Daemon holds a **persistent Curve25519 keypair** (`$PASEO_HOME/daemon-keypair.json`, mode 0600).
- The pairing QR/URL carries the daemon's public key **in the URL fragment**, so the web host never
  sees it. That is the out-of-band trust anchor.
- The client generates a **fresh ephemeral** Curve25519 keypair per connection and sends
  `e2ee_hello` with its public key; the daemon processes no application message before the
  handshake completes.
- ECDH → shared key → **XSalsa20-Poly1305 (NaCl `box`)**, wire format `[24-byte nonce][ciphertext]`.
- Known gap they state plainly: fresh keys per session make cross-session replay impossible, but
  **within a live session there is no replay protection** (random nonces, no counters).

### Why reusing the relay does not fit pi-xfer

The friction the user hit is structural, not incidental:

- **Online-only.** Sessions live in an in-memory registry with a 60 s / 5 min eviction sweep. The
  frame buffer (200 frames, 64 MiB, evict-oldest) only covers the race while the daemon's data
  socket is still connecting — not "this node has been off for six hours". pi-xfer's durable queue
  and `/xfer mesh list` of offline nodes are exactly what the relay cannot do.
- **No discoverable address.** Routing is by a random-hex `serverId` + `connectionId`: unguessable
  by construction, and therefore discovery-hostile. pi-xfer addresses nodes as
  `getOrCreate("xfer-instance", [name])` — a stable, listable, guessable name. That is what makes
  engine-side discovery free, and what makes impersonation possible.
- Replacing the engine with this relay would delete descriptions, offline delivery, and the board
  model that ADR 0013 / 0014 / 0016 exist to provide.

**So: borrow the crypto envelope, not the transport.** Keep the engine for discovery + durability;
make what it stores opaque.

### What to take, concretely, dependency-free

Node's own `crypto` is enough — verified locally:

- `generateKeyPairSync("x25519")` + `diffieHellman({privateKey, publicKey})` → 32-byte shared
  secret.
- `hkdfSync("sha256", shared, salt, "pi-xfer/1", 32)` → message key.
- `createCipheriv("chacha20-poly1305", key, 12-byte nonce, {authTagLength: 16})` → AEAD.

No new runtime dependency, no native addon, no libsodium. This is the Node equivalent of Paseo's
NaCl box (ChaCha20-Poly1305 instead of XSalsa20-Poly1305; same guarantees).

Shape for pi-xfer:

1. Each node generates a persistent X25519 keypair on first `mesh up`, stored next to
   `mesh.config.json` with mode 0600; the **public** key goes in `XferInstanceState` beside
   `description` (engine-side, cross-machine for free).
2. `xfer_mesh_to` encrypts `document` with a per-handoff ephemeral keypair against the recipient's
   advertised public key and puts `{ epk, nonce, ciphertext }` in the message instead of
   `document`. `onHandoff` decrypts. The engine only ever holds ciphertext, in transit and in its
   RocksDB queue.
3. Trust anchor: an out-of-band fingerprint exchange over the existing local socket, e.g.
   `/xfer mesh trust <name> <fingerprint>`, TOFU on first contact (SSH-style). This is the same role
   Paseo's pairing QR plays, and it **also closes the peer-identity gap** from
   `notes-mesh-peer-identity.md`: a forged `xfer-instance` actor can advertise any public key, but
   it cannot decrypt the handoff nor produce a message the trusted key accepts.
4. Replay: include the handoff id and a nonce, and dedupe on id — Paseo's stated in-session gap is
   the one thing not to copy.

### The caveat that keeps TLS on the list

E2EE protects *payloads*, not the control plane. An on-path attacker still steals the admin token
(§5.1) and with it can read all metadata and queue sizes, destroy actors, DoS, and register a
same-name `xfer-instance` actor to intercept traffic. So the ordering from §7 stands: TLS or a
private network first, E2EE second as defense in depth plus peer authentication.

### References

- `github.com/azzgo/paseo-relay` — `main.go` (`registry.get` lazy session creation, `frameBuffer`
  bounds), `CHANGELOG.md` v0.4.0/v0.5.0 hardening notes, README security section.
- Paseo `SECURITY.md` — relay threat model, daemon keypair, `e2ee_hello`/`e2ee_ready`, NaCl box
  wire format, stated replay gap.

## 9. Direction recorded from the user (2026-10-17)

The user's own deployment will be **Cloudflare Tunnel in front of the private engine port** (to hide
it and borrow Cloudflare's HTTPS) **plus an E2EE layer** in pi-xfer. Because the tunnel is a personal
solution, the private-deployment guide must state the MITM risk explicitly and make clear that
external operators are on their own for transport security.

Reflected in `docs/guides/mesh-setup.md` as of this note:

- New section **"Transport security is your responsibility"** — pi-xfer/Rivet encrypt nothing; TLS is
  a function of the `endpoint` scheme; the `6420`-must-not-be-public rule; the three acceptable
  shapes (private network / own TLS proxy / TLS-terminating tunnel); the admin-token blast radius
  and the plaintext handoff exposure; and an explicit "this is your responsibility, not pi-xfer's".
- **Edge-termination subsection** — a tunnel hides the port but the provider decrypts, so it sits
  inside the trust model; plus the two practical caveats (idle-WebSocket cuts, and `/ui` going public
  with the engine).
- Corrected the stale claim that self-hosted engines accept anonymous traffic by default (auth is on
  by default since Rivet's 2026-09-29 change), and the unqualified `http://` example.
- Two new troubleshooting rows (edge idle-timeout churn; "handoffs are readable on the path").

Still open, and belonging to the design node — not implemented:

1. Application-layer E2EE (§8): per-node X25519 keypair in actor state, one-shot sealed handoff
   envelope, fingerprint trust anchored out-of-band. ADR-worthy, since it changes the wire format
   and `XferInstanceState`.
2. Whether the Cloudflare Tunnel topology needs a heartbeat in the mesh runner (idle WS cuts are a
   deployment-level risk, not a code bug, but reconnects should be verified).
3. Key storage on disk (0600, next to `mesh.config.json`) and what `mesh down` must not destroy.

## 10. Heartbeat cost on Cloudflare Tunnel (research, 2026-10-17)

Question: a WebSocket heartbeat is acceptable, but does it create meaningful pressure on Cloudflare
billing/usage statistics?

**No. On the Tunnel path the heartbeat is effectively free, and it is not even counted as a
request.** Details, all from Cloudflare's own docs:

- **Tunnel is free.** Announced for all plans ("any organization can use … at no cost"); the account
  limits page lists tunnels, routes, published apps, replicas — **no bandwidth entry**.
- **Bandwidth is not billed at all.** "Bandwidth — Included in all plans. Cloudflare does not charge
  for bandwidth", and there are no egress fees between Cloudflare and the origin.
- **WebSockets are billed as one request.** "Cloudflare recognizes only the initial upgrade request
  per WebSocket connection as an HTTP request … it will be counted as a single long-lived HTTP
  request." Messages do not add requests. Bandwidth is measured only for Cloudflare → client
  transfer, and is unbilled anyway.
- **Analytics lag is the real effect.** Aggregated WebSocket usage shows up in Traffic Analytics /
  GraphQL / HTTP request logs **after the connection closes**. A heartbeat that keeps the socket
  open forever therefore keeps that connection out of the aggregate — the cost pressure the user
  sensed is real but it is *observability*, not money. (Cloudflare's own WebSocket-handoff
  limitation is similar: "lesser visibility (you are unable to view total bandwidth of websockets
  in the zone)".)

Size of the thing, for a 3-machine mesh with 30 s heartbeats: 3 long-lived sockets × 2 msg/min ×
60 × 24 × 30 ≈ **259k messages/month**, a few bytes each — on the order of a couple of MB. At one
upgrade request per socket, the request count is a rounding error on the 100k/day free tier.

If the engine ever moves onto Cloudflare proper (the serverless-pool idea in
`notes-mesh-boundary-extension.md`), the numbers still do not bite:

- **Workers:** a WebSocket connection is one request; "WebSocket messages routed through a Worker do
  not count as requests" at all.
- **Durable Objects:** incoming WebSocket messages are billable at a **20:1** ratio (outgoing
  messages and protocol pings are not charged). 259k messages/month ÷ 20 ≈ 13k billable requests —
  inside the included 1M, or inside the Free plan's 100k/day.

### What this changes (and does not)

- No cost-driven reason to avoid a heartbeat.
- The heartbeat may not even be ours to add: the long-lived socket is the **runner registration**
  (`setup({ runtime: "native" })`), owned by RivetKit's native runtime — the JS bundle has no
  application-level ping (`mesh-runtime.cjs`'s "ping" hits are substrings of "stopping"), and Node's
  WebSocket auto-replies to peer pings without sending its own. Whether that native runner already
  keeps the connection alive through a 100 s edge idle timeout is **unverified** and needs the
  empirical tunnel test before any code is written.
- Practical prerequisite: a named tunnel needs the domain on Cloudflare; `trycloudflare.com` quick
  tunnels are ephemeral and not a deployment shape.

## 11. Live test on the real deployment (2026-10-17, after the Cloudflare Tunnel cutover)

The tunnel went live as `https://engine.example.com/` (token embedded as URL auth, machine `laptop` pinning
`pool=laptop`). Measurements taken from this host, read-only, against the running engine.

**Tunnel path works end to end.** REST discovery returns 200; an actor RPC round-trip
(`getDescription` on this host's own node) succeeds — **3.5 s cold** (waking a Sleeping actor) and
**1758 / 1171 / 951 / 990 ms warm**. So the ~1 s figure is the tunnel's per-RPC cost, not a bug.

**A cross-machine handoff actually landed.** `milestone` → `remote-node`, 391 bytes, kind `task`;
the target echoed the nonce verbatim and reported inbound id, `from`, pool `remote-node`, and the same
tunnel endpoint. First confirmed end-to-end delivery through the tunnel.

**The runner already keeps itself alive — the heartbeat question is closed.** `/envoys` shows each
live runner with `last_ping_ts` 1–3 s old and `last_rtt` 442 ms (`laptop`) / 565 ms (`remote-node`). The
native runner pings continuously, so Cloudflare's ~100 s idle-WebSocket cut does not reach it. No
heartbeat needs to be added on our side; §10's open item is settled by observation, not by a code
change.

**A failed target is indistinguishable from a live one in `mesh list`.** With four actors listed,
`peers` reported all four as `Sleeping`; in fact only `laptop` and `remote-node` had runners attached. The
`phone` actor carried `error: "no_envoys"` and failed every send after the documented 30 s
timeout, while `remote-node` accepted one immediately. The engine's own actor record holds the
distinguishing fact; `list` does not surface it. This is the "missing observation channel" from §9
observed in the wild, and a concrete milestone candidate (`mesh list` / `peers` showing each node's
status, or at least whether a runner is attached to its pool).

**The dashboard is anonymously reachable through the tunnel** — the caveat in `mesh-setup.md`
("the dashboard comes along") confirmed against the live host:

```
GET /ui                                    → 200  (dashboard HTML, no auth)
GET /actors?name=xfer-instance&namespace=… → 401  invalid_token
GET /health                                → 200  {"runtime":"engine","version":"2.3.26"}
```

The API is properly gated, but the console page and the version string are public. Gate `/ui` at
Cloudflare Access, or do not publish the engine hostname publicly.
