# Install xfer-agent for your host

This file lets an agent install the xfer-agent skill for **its own** Agent Host
without a human picking flags. Read it, identify your host, and run the
generated command.

## 1. Identify your host

| If you are… | `--host` |
|---|---|
| Cursor | `cursor` |
| any other host (Claude Code, grok bot, a custom harness, plain shell) | `generic` |
| a host not listed above | `generic` first — it covers anything with a shell. Only
  add a named preset if your host needs somewhere else installed or a different
  launch command; send a PR or fork. |

## 2. Install into your skill directory

```sh
xfer-adapterd install --host <host> --into <skill-dir>
```

Pick `<skill-dir>` where your host loads skills from (for Cursor:
`~/.cursor/skills/xfer-agent`; otherwise a directory your harness reads).

The installer writes:

- `SKILL.md` — generic operations (up / send / inbox take / rename)
- `install.md` — this file
- `overlay-<host>.md` — host-specific notes
- `.xfer-agent.json` — the host kind, the agent name, and the recommended
  **launch command** for this machine

## 3. Launch

Read `.xfer-agent.json` and run its `launchCommand` in the background. The
daemon owns this agent's socket and inbox at `~/.pi/xfer/`.

## 4. Verify

```sh
xfer-adapterd inbox list
```

Exit code 0 means the daemon is up (empty output just means no pending
handoffs). A non-zero exit printing `no daemon "X" — start one with
\`xfer-adapterd up --name X\`` means that name was never started. The
recommended launch command is regenerated on every install, so an agent never
has to construct flags itself.

## Adding a host preset

A preset is `hosts/<name>.md` plus a `--host` branch. It carries **where the skill
installs and what the launch command is — nothing else.** In particular a preset must not
carry delivery logic: no code that decides how a handoff reaches the agent. That line is
deliberate, because per-host delivery is the thing that drifts with other projects'
releases and cannot be covered by this repo's hermetic tests.
