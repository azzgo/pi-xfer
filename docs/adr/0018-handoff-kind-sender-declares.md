# Handoff Kind: the sender declares, the receiver never judges
[简体中文](0018-handoff-kind-sender-declares.zh.md)

A Handoff carries a Kind — `Notification` (informs; silent by default) or `Task`
(asks for output; exactly one conclusion comes back). The sender declares it, and
the receiver never decides whether its own output is worth sending back.

The previous rule — "reply only if you have meaningful new information to
communicate back" — failed because a receiver can always justify its own status
as meaningful, so every finished handoff produced a receipt. Also rejected: a
separate Reply/Receipt vocabulary (Kind already covers both), a `/xfer notify`
command (that moves the judgement to the agent instead of removing it), and
folding Kind into the cwd-stamp comment (that line is written by the pi tools
only, while Kind must hold for every host).

## Consequences

- A Task's reply is an obligation on the receiver, not a delivery guarantee:
  there is still no reply wait, and a sender must not block on it.
- An undeclared Kind reads as `Notification`. Senders that predate the field go
  silent rather than receiving receipts — a deliberate one-way migration.
- Kind is one line in the doc head (`kind: task|notification`), stamped by the
  sending tool from a required parameter, so it never depends on the model
  writing the markdown correctly.
