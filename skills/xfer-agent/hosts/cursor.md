# Cursor host overlay

- Install this skill to `~/.cursor/skills/xfer-agent` (per-user) or
  `<repo>/.cursor/skills/xfer-agent` (per-project).
- Launch the daemon as a background process when the workspace opens. On macOS a
  plain `nohup` works:
  `nohup {{LAUNCH_COMMAND}} > ~/.pi/xfer/{{NAME}}.log 2>&1 &`
- To rename, kill the daemon and relaunch with a different `--name`; the old
  socket and metadata are removed on graceful shutdown.
- The recommended launch command for this machine:

```
{{LAUNCH_COMMAND}}
```
