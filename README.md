# Xfer — unidirectional cross-project handoff extension

Generate a markdown handoff doc via a `/handoff-style` prompt, send it via Unix
socket to another Pi instance. **One-way only, no wait.** Reply by calling
`/xfer` again.

## Install

```bash
just install-pi    # auto symlink ~/.pi/agent/extensions/xfer → repo folder
```

## Web Picker (page side)

`web-picker.user.js` is the Tampermonkey page side of the broker: pick
elements, annotate (solo or shift-group), send handoffs, and answer the
agent's page-tool queries (fixed op table — no eval, no modal). Since
v1.12: per-origin auto-reconnect after the first manual link (exponential
backoff), gated write ops (`dom.click` / `dom.setValue`, per-origin
authorization), and reload-stable tab addressing so the broker routes
follow-up queries back to the same tab. Source lives in `web-picker.src/`
(`npm run build` rebuilds the committed `web-picker.user.js`; protocol
constants come from the shared `wire.ts`).
Install — open the raw URL in a browser with Tampermonkey enabled;
the `.user.js` suffix triggers the install prompt automatically:

<https://raw.githubusercontent.com/azzgo/dotfiles/main/pi/agent/extensions/xfer/web-picker.user.js>

Manual install, shortcuts and troubleshooting:
[`docs/web-picker.md`](docs/web-picker.md).

## Usage

| Command | Meaning |
|---------|---------|
| `/xfer` | help |
| `/xfer list` | list peers (local socks) + listener status |
| `/xfer name [<name>]` | show or set this agent's name |
| `/xfer <target> <request>` | handoff to a peer (LLM doc + `xfer_to`) |
| `/xfer gc` | reap zombie peer sockets (dead pid / no listener) |
| `/xfer status` | listener status summary |
| `/xfer mesh` | mesh status (opt-in cross-machine transport) |
| `/xfer mesh up` / `down` | bring this instance online as its xfer name / destroy the node and go offline |
| `/xfer mesh list` | list mesh nodes (live engine query, no cache) |
| `/xfer mesh <name> <request>` | handoff to a mesh node (LLM doc + `xfer_mesh_to`, doc sent inline) |

### Zombie socket GC

A peer that dies without cleaning up (crash, `kill -9`, closed terminal)
leaves `<name>.sock` + `<name>.json` behind. `/xfer gc` reaps them:

- `<name>.json` `pid` no longer alive (`kill(pid, 0)` → ESRCH) → remove both
- metadata missing/unreadable and nothing listening on the sock → remove both
- orphan `.sock` with no `.json` and no listener → remove the sock
- anything ambiguous (EPERM, probe timeout) is kept — gc never removes a
  peer that might be alive; `broker.*` files are never touched

### LLM tools

`xfer_to(target, summary, handoff_document)`:

1. write `/tmp/pi-xfer-<id>.md`
2. socket-notify target `{file, summary}`
3. return `handoff_id` immediately (no wait)

- **Annotations**: `openWorldHint: true` (cross-agent socket); not read-only, not destructive.
- **Structured value** (`outputSchema`): `{ handoff_id, target, document, status }` —
  `document` is the `/tmp` handoff-doc path; codemode callers receive this object
  instead of the text content. Failures throw.
Reply by `/xfer <original sender> <message>` — each xfer is an independent
one-way message. **Exception:** a handoff whose sender is `web-picker` comes
from the browser userscript, not an agent — it has no xfer socket and can never
be an `xfer_to` target. The only return channel is the broker page-tool CLI
described in the doc's "Follow-up channel" section.

### Mesh (opt-in cross-machine transport)

Local Unix-socket delivery above is unaffected by the mesh; the two transports
are explicit and never auto-fallback. To join, create `~/.pi/xfer/mesh.config.json`:

```json
{ "endpoint": "http://localhost:6420", "namespace": "default", "token": "sk_..." }
```

(namespace/token may also ride the endpoint as URL auth: `https://ns:token@host`.)
`/xfer mesh up` starts a RivetKit worker in-process (single `xfer-instance`
actor, key = xfer name) and refuses if a same-name node already exists on the
engine. Inbound mesh handoffs land in `/tmp/pi-xfer-<id>.md` and flow through
the same delivery pipeline as local socks, labeled `· mesh`.

**Distribution**: rivetkit is bundled into the committed `mesh-runtime.cjs`
(`mesh-runtime.src/` is the source; `npm run build` rebuilds — same双轨模式 as
web-picker). The extension has zero runtime node_modules. The rivetkit **native
runtime** (napi addon + engine binary, ~140MB, platform-specific) cannot be
bundled, so the first `mesh up` downloads the pinned version
(`RIVETKIT_VERSION` in `mesh-native.ts`, kept in sync with the bundle by
build.mjs) from npm into `~/.pi/xfer/cache/` (never in git; keyed by version —
bump the pin and old caches age out). No network at runtime after that;
failures surface an `npm pack`-based manual recovery hint.

## Protocol

- Unix socket at `~/.pi/xfer/<name>.sock` (always on)
- Peer metadata at `~/.pi/xfer/<name>.json` (session name, cwd, model,
  status, pid, startedAt — refreshed by a 1s poll + status events)
- Message: `xfer-notify` (JSON lines, one-way; target remains the xfer name)

## Tests

```bash
npm test    # node --test, zero deps (inline .js→.ts resolve hook)
```

## Layout

| File | Responsibility |
|------|----------------|
| `index.ts` | entry wiring: flag, `xfer_to` tool, status events, lifecycle |
| `controller.ts` | inbound socket lifecycle: start / rename / shutdown |
| `commands.ts` | `/xfer` command (`list`, `broker`, `board`, `gc`, `status`, `name`, …) + completions |
| `board.ts` | async collaboration board: Markdown cards in `~/.pi/xfer/board/`, two-phase writes via `agent_end` interception |
| `gc.ts` | zombie-socket GC: dead-pid / orphan-sock detection + reap |
| `state.ts` | runtime identity + `<name>.json` metadata write/poll |
| `client.ts` | outbound `sendNotify` (connect → send → wait ack) |
| `server.ts` | inbound server: parse frames, deliver, ack (unix socket) |
| `utils.ts` | pure helpers: name encoding, endpoints, peer listing |
| `constants.ts` | paths + timeouts |
| `mesh.ts` | mesh node lifecycle + inline handoff send/receive (opt-in) |
| `mesh-engine.ts` | RivetKit adapter: actor definition, engine REST discovery, queue send |
| `mesh-config.ts` | `mesh.config.json` parsing + actor key (de)serialization |
| `mesh-native.ts` | native runtime provisioning: version-pinned npm download → `~/.pi/xfer/cache`, engine-cli mini-package, loader globals |
| `mesh-runtime.cjs` | committed esbuild bundle (mesh-runtime.src + rivetkit) — what `/xfer mesh up` actually runs |
| `types.ts` | `PeerInfo`, `XferNotifyMessage`, `Identity` |
| `web-picker.user.js` | Tampermonkey page-side picker — see [docs/web-picker.md](docs/web-picker.md) |
