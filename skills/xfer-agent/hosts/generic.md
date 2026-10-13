# Generic host overlay

- Install this skill wherever your harness reads skills from.
- Start `xfer-adapterd` as a background service at session start; it owns this
  agent's socket and inbox under `~/.pi/xfer/`.
- Recommended launch command for this machine:

```
{{LAUNCH_COMMAND}}
```

- `send` needs no daemon, so a send-only host may skip the background process.
- Renaming means stopping the daemon and relaunching with a different `--name`.
