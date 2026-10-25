> 中文版 · 英文原文：[0018-handoff-kind-sender-declares.md](0018-handoff-kind-sender-declares.md)

# Handoff Kind：发送方声明，接收方从不评判

一份 Handoff 携带一个 Kind——`Notification`（告知；默认沉默）或 `Task`（要求产出；恰好回一条
结论）。发送方声明它，接收方永远不决定自己的产出是否值得发回去。

先前的规则——"只有当你有值得回传的、有意义的新信息时才回复"——失败了，因为接收方总能把自己
的状态说成是有意义的，于是每一份完成的 handoff 都会产出一张回执。同样被否决的还有：一套单独的
Reply/Receipt 词汇（Kind 已经覆盖两者）、一个 `/xfer notify` 命令（那只是把判断从移除变成转移
给 agent）、以及把 Kind 折进 cwd 戳注释里（那一行只由 pi 的工具写入，而 Kind 必须对每个宿主都
成立）。

## 后果

- Task 的回复是接收方的一项义务，不是投递保证：依然没有回复等待，发送方不得阻塞在它上面。
- 未声明的 Kind 读作 `Notification`。早于该字段的发送方会保持沉默，而不是收到回执——这是一次
  有意的单向迁移。
- Kind 是文档头部的一行（`kind: task|notification`），由发送工具根据一个必填参数打上，因此它
  从不依赖模型把 markdown 写对。
