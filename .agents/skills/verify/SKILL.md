---
name: verify
description: Verify admin page and interactive command changes in a real browser/session.
---

# Verify

npm test covers headless logic. It cannot see a rendered page or an interactive
command. When your change has a visible or interactive surface, verify it with
the channel below — do not ask the user to look at the screen for you.

## Which copy is under test

pi-xfer is installed globally as `npm:pi-xfer` **and** exists here as a working
tree. Both copies register `xfer_to`, `xfer_mesh_to` and the `--xfer` flag, so a
session that loads both fails to start with one error per duplicate name:

```text
Error: Failed to load extension ".../node_modules/pi-xfer/index.ts": Tool "xfer_to" conflicts with .../pi-xfer/index.ts
```

Rules:

- Never `pi install <path to this repo>` and never add a local path to
  `~/.pi/agent/settings.json`. The single global entry stays `npm:pi-xfer`;
  upgrades go through `pi update --extensions`.
- Exercise the working tree with `pi -ne -e ./`: `-e ./` loads this repo's
  `index.ts`, `-ne` skips extension discovery so no installed copy can load
  beside it. Skills, prompts and context files still load.
- `-ne` also drops built-in extensions, MCP included — use a normal pi session
  when a channel needs MCP tools.
- Under `-ne -e ./` a "conflicts with" error means the working tree registers a
  duplicate itself: a real bug. Outside it, it means a duplicate install.

## Channel 1 — admin page (chrome-devtools MCP)

The repo tracks `.pi/mcp.json` with the `chrome-devtools` MCP server. It is
loaded after project trust is granted; first-time contributors must approve the
trust prompt. Tools are prefixed `mcp__chrome_devtools__`.

```text
1. Serve the page under test from a working-tree session: `pi -ne -e ./` in the
   repo root, then /xfer admin (or inspect via admin-manager for the existing
   URL — it is a global singleton; if already served, reuse the URL).
   Drive the browser from this agent's normal pi session, since -ne has no MCP.
2. mcp__chrome_devtools__navigate_page  → the admin URL
3. mcp__chrome_devtools__take_screenshot → look at it before judging CSS
4. Interact: click tabs/buttons, then screenshot again
5. Check both themes if a theme toggle exists
```

Rules:

- Never claim a button/layout/style is correct without a screenshot after the
  change. The cost of one screenshot is far below the cost of a user
  correction round.
- Danger-styled actions (stop, gc) get checked in their resting state too.
- No Chrome on the machine? Fall back to telling the user which URL to open
  and what to look at. State plainly that verification was not done by you.

## Channel 2 — extension commands (tmux)

Drive a real pi session with the extension loaded. This pattern is verified —
it is how this skill's smoke test was written:

```bash
tmux kill-session -t verify-smoke 2>/dev/null
tmux new-session -d -s verify-smoke -x 100 -y 30 -c <repo-root>
tmux send-keys -t verify-smoke 'pi -ne -e ./' Enter
sleep 6 && tmux capture-pane -t verify-smoke -p | tail -20   # after startup
tmux send-keys -t verify-smoke '/xfer list' Enter
sleep 3 && tmux capture-pane -t verify-smoke -p | tail -15   # command output
tmux send-keys -t verify-smoke Escape; sleep 1
tmux send-keys -t verify-smoke '/exit' Enter; sleep 2
tmux kill-session -t verify-smoke
```

Rules:

- Capture the pane after every step; never assume a command succeeded because
  `send-keys` returned.
- Long-running commands (broker ops) can hang the foreground — poll with
  `capture-pane` instead of waiting on the command.
- Replace `/xfer list` with whatever command you changed. A startup screen
  alone is not a pass; the changed command must produce visible output.

## Manual smoke checklist (release)

When neither channel is available (contributor without Chrome, headless CI):

- [ ] `npm test` green, build artifacts byte-identical
- [ ] `pi -ne -e ./` loads the extension with no errors in the startup banner
- [ ] `/xfer list` responds
- [ ] `/xfer admin` starts, opens a working page, tabs switch
- [ ] Stop / gc actions work and are visibly styled as dangerous
