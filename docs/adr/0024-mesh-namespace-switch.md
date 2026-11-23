# Mesh namespace switching is offline-only, single-key, and in memory

Status: accepted

`/xfer mesh ns` moves a session to another engine namespace (Enter: this process
only, `ctrl+s`: the `namespace` in `mesh.config.json`). Three narrow decisions
around it are deliberate, and each has a "helpful" alternative that must stay
rejected:

- **Offline only.** A Node's actor lives in the namespace it joined, so switching
  while online can only either leave the Node present in two namespaces at once
  or destroy the actor — and `down` is the sole destroying path in this product.
  The command refuses while online and names `/xfer mesh down` as the next step.
- **One write path, one key.** Persistence happens only through `ctrl+s` in the
  picker, and it rewrites exactly the `namespace` field, leaving every other key
  (`$schema`, `endpoint`, a `$ENV` / `!command` token, `pool`) and the file mode
  untouched. There is no flag, env var, or general config editor. A namespace
  authored as an expression is refused rather than replaced: silently turning a
  deployment decision into a literal is the one edit a machine cannot make on the
  user's behalf. A single write path is also a single review path.
- **Session scope is memory, not a file.** The override dies with the process; a
  reload or restart returns to the Default namespace. Persisting it would invent
  a second default that only this extension knows about.

What pays for the narrowness is visibility: the Identity line carries the
Effective namespace (marked when overridden), and every query surface names the
namespace it read, so a temporary switch cannot be forgotten silently.

Rejected alternatives: a warm switch (duplicate presence), a generic
`/xfer config` editor (a file that may hold expressions cannot be rewritten by
something that cannot evaluate them — revisit only when a second field actually
needs writing), and a persisted override (a second source of truth for the same
fact).
