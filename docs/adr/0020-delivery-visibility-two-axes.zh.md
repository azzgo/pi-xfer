> 中文版 · 英文原文：[0020-delivery-visibility-two-axes.md](0020-delivery-visibility-two-axes.md)

# 投递可见性是两个轴：Delivery verdict 与 Handoff outcome

`xfer_to` 与 `xfer_mesh_to` 都返回一个恒定的 `status: "sent"`——无论目标是醒着、睡着、已入队
还是已消失，都一模一样。修正它需要一个**不是** `Delivery verdict` 的术语：那个术语在
`CONTEXT.md` 里已经定案，指的是一个*列表*对某个 **Node** 究竟能否接收所作的主张，mesh 传输
实现的正是它。Milestone 4 的第 1 项要求的是另一种主张——一份 **Handoff** 停在了哪里。两个轴，
一个词；这个碰撞就是本决策。

**两个轴，两个术语。** *Delivery verdict* 保持 Node 作用域且不变。*Handoff outcome* 是
Handoff 作用域的那个：就网络能诚实给出的程度而言，一份 Handoff 停在了哪里。四个值——
`queued` / `delivered` / `unknown` / `not-delivered`——由两种传输共享，各自只达到它能支持的
子集（mesh 有持久队列，可以说 `queued`；本地没有，只能说 `delivered`）。

**Outcome 在传输时计算，之后什么都不承诺。** `pi.sendMessage` 返回 `void`，因此连接收方也无从
得知一份 Handoff 后来怎样了，而 ADR-0015 选择了一个刻意有损的 take-to-read Inbox，持久归档
早已被否决。因此"是否被读过"是不可达的，而不只是尚未构建。mesh 一侧自己也早已触到这个天花板：
`not-delivered | unknown | failed`（`mesh-engine.ts`），其中 `unknown` 承载着关键作用，恰恰
因为第二次发送会把一个歧义变成真正的重复。

## 后果

- `unknown` 在任何传输上都绝不能建议重试。这不是风格偏好——这正是该值单独于 `not-delivered`
  存在的原因。
- 一个没有 outcome 字段的 ack 帧意味着 `unknown`，绝不是 `delivered`。因此旧接收方和 broker
  的转发路径会向诚实退化，而不是向假阳性退化。
- Milestone 4 的第 0 项缩减为第 1 项的两个前置条件：`isRuntimeIdle()` 还必须询问
  `hasPendingMessages()`，否则一份停在排队轮次后面的 Handoff 会错误地报告 `delivered`；而
  本地 bind 必须区分活端点与崩溃端点，否则 `delivered` 会对一个你并未指名的 Node 返回 true。
- Outcome 对是否会有反向 Handoff 只字不提。第 4 项的循环守卫不能建立在它之上——那个守卫是关于
  语义层的，需要自己的依据。
- **不存在入站的 `held` 状态，而且往 mesh 里加一个也不会成为特性。** 于 2026-10-19 决定，此前
  也考虑过仅本地的变体，同样因不值得引入它所带来的状态而被否决：全盘接受或停止监听才是永久的
  形态。`held` 在 mesh 上根本行不通——actor 的 `run` 调用 `onHandoff`（同步，`void`），然后
  在下一行无条件写 `recordMeshDelivery`，于是一条被 held 的消息会被记成已投递，任何重投都会
  被当作重复而丢弃，而接收方重启就会失去它。支持它意味着改动 ADR-0013 定义的持久队列契约。这
  值得记录，因为 Reason 的词汇是 `stored | delivered | held
  | refused`，未来的读者比较两者时会问为什么这里少了一个值。
- 本地不增加预检。它的 Node 轴是退化的（端点存在或不存在），且与 mesh 不同，一次误判通过的代价
  只是一次失败的连接和一个 `unlink`。

- **`xfer-adapterd` 的失败行是一种线上格式，不是散文。** `xfer-adapterd send` 在错误行末尾带上
  四个值之一（`… ack timeout unknown`），而 `mcp-gateway.mjs` 从那个尾词恢复 outcome；它找不到
  的值会退化为 `unknown`。这是有意的且有测试钉住——一个退出码加一句话承载不了一个四值答案，
  这正是 gateway 在初版里凭空造出第五个值的原因。它确实意味着 CLI 的错误措辞是承重的：
  **改写措辞会破坏 gateway 的 outcome 映射。** gateway 把任何无法识别的成功 token 强制转为
  `unknown` 而不是信任它，并且一旦第五个值在任何地方出现，测试就会失败，因此失败模式是永久
  `unknown` 的 outcome，而不是假的成功。

- 面向远程 MCP 客户端（云端 agent、手机宿主）的公共 relay 被**有意推迟出 Milestone 4**，不是
  遗漏：它在 mesh 上是客户端角色（`sendMeshHandoff`，不加入，无 actor），但需要认证，因为一个
  未认证、能把消息入队到别人 mesh 的端点，与 ADR-0019 所推理的 unix socket 是不同的暴露面。
  认证是需要有人维护的东西；它不属于一个便利特性。Milestone 4 的第 2 项范围仅限本地 stdio
  gateway。
