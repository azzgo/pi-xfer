# Milestone 2 design — P1-D handoff cwd anchoring
[简体中文](phase2-design-p1d.zh.md)

## Decision (2026-10-13)

Mechanical sender-side stamping + envelope instruction; no receiver-side enforcement.
Consumer-side answers (refine) are incorporated: degrade to project/machine anchor
cross-machine; instruction lives in the envelope text, stamp in the doc.

## Current mechanics (verified)

- `index.ts` `xfer_to` execute writes the doc to `os.tmpdir()/pi-xfer-<mid>.md` and sends
  an `xfer-notify`; `xfer_mesh_to` sends the document inline over the mesh.
- Both inbound transports (local socket, mesh) converge on `controller.ts
  `deliverInbound()``, which builds the `📨 [Xfer from …]` envelope. Web-picker senders
  are special-cased there already.
- The sending process knows its cwd (`process.cwd()`) and machine (`os.hostname()`).

## Plan

### 1. Doc stamp (sender side, `index.ts` both tools)

- Prepend one line to the doc before writing/sending:
  `<!-- xfer:sender-cwd cwd=<abs-path> project=<basename> machine=<host> branch=<git-branch?> -->`
- `branch` read from `<cwd>/.git/HEAD` (file read, no subprocess); omitted when absent
  (non-git or cross-machine-unresolvable). `machine`/`project` always present — they are
  the cross-machine anchor when `cwd` does not exist locally (worktrees of the same repo
  at different paths).
- Web-picker-originated docs (`handoff-doc.ts`) get no stamp — the "sender" is a browser,
  not a working directory; the envelope already steers those differently.

### 2. Envelope instruction (`controller.ts deliverInbound`)

- For agent senders, add after the Doc line:
  `**Sender cwd**: \`/path\` (project X on machine Y) — make all file edits here unless the
  doc says otherwise.`
- If the sender is not local (mesh, unknown host), the same line adds: "if that path does
  not exist on this machine, locate the project (and worktree/branch if given) before
  editing — ask the user only if ambiguous."

### 3. Mesh inline path

`xfer_mesh_to` stamps the inline document the same way, so mesh receivers parsing the raw
doc still see the anchor even when they read the file-less inline body.

## Touched areas

`index.ts` (both tool executes: stamp helper), `controller.ts` (envelope), small pure
helper (stamp formatting + `.git/HEAD` read) with unit tests; docs: a line in
`docs/dev` handoff workflow notes if such a doc exists.

## Risks
## Risks

- Test fixtures must use synthetic paths (e.g. `/tmp/proj`, fake hostnames) — the stamp
  itself is runtime-only data and never enters the repo, so the pre-push personal-path
  guard is not a concern here; hermetic tests are the existing rule anyway.
- Receivers may treat the comment as invisible (HTML comment chosen so rendering stays
  clean; the envelope line is the authoritative instruction).
- No enforcement by design — wrong-cwd edits remain possible; accepted (cheap to spot
  and revert; revisit if they recur post-ship).
