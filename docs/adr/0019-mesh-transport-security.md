# Mesh transport security: TLS is a deployment duty, not a pi-xfer feature

Status: accepted

## Context

The mesh (ADR 0013) is a shared engine with one actor per Node, a durable queue, and no message
broker of its own. It went live behind a Cloudflare Tunnel on 2026-10-17, which is when its security
posture stopped being hypothetical: the traffic is real, the admin token is real, and the tunnel
operator terminates TLS.

Nothing on that path is encrypted by pi-xfer, and nothing is encrypted by RivetKit. This was never a
decision anyone recorded — it is a consequence of two earlier ones: handoff documents are inlined
into the queue message (ADR 0013, because cross-machine `/tmp` paths do not travel), and the
transport is whatever the `endpoint` scheme says it is. The setup guide says as much in prose, but a
guide written for an operator choosing a deployment cannot state what pi-xfer *is*, so it cannot stop
the next reader from assuming that moving to HTTPS made the mesh safe.

This ADR records the posture so it is not re-derived — and, since P1-C (an application-layer E2EE
envelope) was declined on ROI, so that it is not mistaken for a pending item either.

## Decision

**pi-xfer adds no cryptography. Transport security is entirely a property of the deployment.**

- **The handoff payload is plaintext, in transit and at rest.** `MeshHandoffMessage.document` is an
  inline string (`mesh-engine.ts` interface; populated in `mesh.ts`), stored by the engine in its
  database and delivered verbatim. This is a settled boundary, not a gap.
- **RivetKit adds none either.** The string "E2EE" appears in its source as a note about *where*
  connection parameters may ride, not as an encryption feature. Its gateway speaks plain HTTP and
  WebSocket.
- **TLS is a function of the `endpoint` scheme alone.** `https://` yields `wss://`, `http://` yields a
  **plaintext** WebSocket; there is no upgrade attempt and no fallback. Verified against pinned
  rivetkit 2.3.26: `combineUrlPath` preserves `baseUrl.protocol` and hands it to `new WebSocket(...)`.
- **The control plane speaks plain HTTP by design.** Port 6420 is expected to be behind TLS or not
  exposed at all.
- **The admin token is a root credential.** It grants every operation in every namespace and is not
  scoped or revocable without a restart. It travels three ways — `Authorization: Bearer` on REST, as
  a `rivet_token.<token>` WebSocket subprotocol, and as `@<token>` inside the gateway URL path — plus
  the runner registration. Protecting it is not a handoff-level concern; it is the whole mesh.
- **Peer identity is the actor type name plus a key.** No handshake, no credential. A same-namespace
  actor registering as `xfer-instance` is indistinguishable from a real node. Since P1-C was
  declined, this is **accepted**, mitigated only by keeping the engine off untrusted networks.
- **A TLS-terminating edge is inside the trust model.** HTTPS protects the wire; it does not protect
  the payload from the party that terminates it.
- **The operator owns the transport.** pi-xfer cannot detect a missing TLS layer, and does not try.

## Acceptable deployment shapes

Ordered by how much they actually protect, which is the ordering a reader should act on.

| Shape | What it protects | What it does not |
|---|---|---|
| **Protocol-level tunnel** (Tailscale, EasyTier, WireGuard) | The entire link — payload, admin token, control plane, RPC metadata — end to end, between peers | A compromised peer machine, or the VPN provider if the overlay is provider-run |
| **TLS in front of 6420** (real certificate, every node's `endpoint` is `https://`) | Handoffs and the admin token between each node and the proxy; `wss://` end to end | Anything after the proxy — `proxy → 6420` is plaintext on that host, and a compromised proxy reads everything |
| **TLS-terminating tunnel** (Cloudflare Tunnel or equivalent) | No public inbound port; HTTPS/WSS at the edge with no certificate work; hides the engine's address | **Privacy from the edge operator**, who decrypts in order to forward and therefore sees both the payload and the token |
| **Bare `http://` on loopback only** | Nothing in itself — the attacker model is another process on the same machine, which already reads the config | Any network hop whatsoever |
| **Bare `http://` on a public or routable interface** | **Not acceptable.** A passive on-path attacker reads the root token and every handoff; an active one rewrites handoffs with no integrity check | Everything |

A protocol-level tunnel is preferred over a TLS-terminating edge precisely because the edge sits
inside the trust model: it protects the whole link rather than only the wire segment, and it costs no
code. A TLS proxy remains acceptable. Bare `http://` on an exposed interface does not.

Application-layer encryption was considered as a further layer and **declined** (P1-C): it protects
only the handoff payload, while a protocol tunnel protects the control plane and the credential too.
Layering it would not have made TLS or a private network optional.

## Measured deployment facts

Observations from the live deployment on 2026-10-17, recorded as measurements rather than guarantees.

- A gateway round trip through the tunnel costs roughly **1 s warm** and **3.5 s cold** (actor wake);
  a control-plane listing costs **0.7–2.4 s**. A request to a pool with no live runner waits for the
  engine's own ~30 s ready-wait and then fails with `guard.actor_ready_timeout`.
- The native runner **pings continuously** (`last_ping_ts` 1–3 s old, `last_rtt` 442–831 ms across
  the session), so an edge idle timeout does not reach the runner registration. No client-side
  heartbeat is required.

## Consequences

- **Plaintext is permanent as far as this design goes.** There is no successor ADR and no planned
  envelope. Anyone revisiting it should read P1-C's decline reasoning first, not assume it was
  deferred.
- **Impersonation stays open.** A foreign `xfer-instance` actor in a live pool is indistinguishable
  from a real node. This is the half of P0-B the envelope would have closed; it is now an accepted
  risk with a deployment-level mitigation only.
- **The operator-facing instructions live in the guide**, not here: `docs/guides/mesh-setup.md`
  carries the configuration steps and the troubleshooting rows. This ADR states the posture and does
  not duplicate them.
- **Choosing a tunnel is a security decision, not a convenience one.** The convenience of an
  outbound-only tunnel is real; so is the fact that its operator can read everything. Load-balancing
  over that trade is the operator's call, and it should be made knowingly.

## References

- ADR 0013 (mesh transport) — why documents are inlined, and the engine/queue model this qualifies.
- ADR 0017 (per-host runner pools) — pool placement, referenced by the deployment shapes above.
- `docs/guides/mesh-setup.md` — the operator instructions this ADR deliberately does not repeat.
- `docs/milestones/notes-mesh-transport-encryption.md` — the underlying investigation (§1–11),
  including the empirical `http://` → plaintext-WebSocket check.
- `docs/milestones/phase3-features.md` — P1-C's decline, which this ADR depends on.
