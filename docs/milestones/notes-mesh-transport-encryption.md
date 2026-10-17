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
