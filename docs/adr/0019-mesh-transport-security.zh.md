> 中文版 · 英文原文：[0019-mesh-transport-security.md](0019-mesh-transport-security.md)

# Mesh 传输安全：TLS 是部署的职责，不是 pi-xfer 的特性

状态：accepted

## 背景

mesh（ADR 0013）是一个共享引擎，每个 Node 一个 actor，带持久队列，自身没有消息 broker。它于
2026-10-17 在一个 Cloudflare Tunnel 后面上线，也就是从那时起它的安全态势不再是假设性的：流量
是真的，admin token 是真的，隧道运营方负责终止 TLS。

那条路径上没有任何东西由 pi-xfer 加密，也没有任何东西由 RivetKit 加密。这从来不是一个谁记录过
的决定——它是先前两个决定的结果：handoff 文档被内联进队列消息（ADR 0013，因为跨机的 `/tmp`
路径不会跟着走），以及传输就是 `endpoint` scheme 所说的那个东西。配置指南在正文里也这么说，
但一份写给选择部署方式的操作者的指南，无法陈述 pi-xfer *是什么*，因此它无法阻止下一位读者
以为搬到 HTTPS 就让 mesh 安全了。

本 ADR 记录这一态势，使它不被重新推导——并且，由于 P1-C（应用层 E2EE 信封）已因 ROI 被否决，
也使它不被误当成一件待办事项。

## 决策

**pi-xfer 不添加任何密码学。传输安全完全是部署的属性。**

- **handoff 载荷在传输中和静态存储时都是明文。** `MeshHandoffMessage.document` 是一个内联
  字符串（`mesh-engine.ts` 接口；在 `mesh.ts` 中填充），由引擎存进它的数据库并原样投递。这是
  一个已决边界，不是缺口。
- **RivetKit 同样不添加任何东西。** "E2EE" 这个字符串在它的源码里出现，是关于连接参数*可以*
  搭载在哪里的说明，而不是加密特性。它的 gateway 说的是纯 HTTP 和 WebSocket。
- **TLS 只是 `endpoint` scheme 的函数。** `https://` 得到 `wss://`，`http://` 得到一个
  **明文** WebSocket；没有升级尝试，也没有 fallback。已对照锁定的 rivetkit 2.3.26 验证：
  `combineUrlPath` 保留 `baseUrl.protocol` 并把它交给 `new WebSocket(...)`。
- **控制面按设计说的是纯 HTTP。** 端口 6420 应当位于 TLS 之后，或者根本不暴露。
- **admin token 是一个 root 凭证。** 它授予每个命名空间里的每一项操作，且没有范围限制，不重启
  就无法吊销。它有三种走法——REST 上的 `Authorization: Bearer`、作为
  `rivet_token.<token>` WebSocket 子协议，以及 gateway URL 路径里的 `@<token>`——再加上
  runner 注册。保护它不是 handoff 层面的问题；它是整个 mesh。
- **对端身份是 actor 类型名加一个 key。** 没有握手，没有凭证。一个同命名空间里注册为
  `xfer-instance` 的 actor 与真实节点无法区分。既然 P1-C 已被否决，这就是**被接受的**，仅靠
  让引擎远离不受信网络来缓解。
- **一个终止 TLS 的边缘位于信任模型之内。** HTTPS 保护线路；它不保护载荷免受终止它的那一方的
  窥视。
- **传输由操作者拥有。** pi-xfer 无法检测缺失的 TLS 层，也不尝试。

## 可接受的部署形态

按它们实际保护的程度排序，这也应是读者据以行动的排序。

| 形态 | 它保护什么 | 它不保护什么 |
|---|---|---|
| **协议层隧道**（Tailscale、EasyTier、WireGuard） | 整条链路——载荷、admin token、控制面、RPC 元数据——在 peer 之间端到端 | 被攻陷的 peer 机器，或（若 overlay 由服务商运营）VPN 服务商 |
| **6420 前面加 TLS**（真实证书，每个节点的 `endpoint` 都是 `https://`） | 每个节点与代理之间的 handoff 和 admin token；端到端的 `wss://` | 代理之后的一切——`proxy → 6420` 在那台宿主上是明文，且被攻陷的代理能读到一切 |
| **终止 TLS 的隧道**（Cloudflare Tunnel 或等价物） | 没有公开的入站端口；边缘提供 HTTPS/WSS 且无需证书工作；隐藏引擎地址 | **对边缘运营方没有隐私**，它为转发而解密，因此既看到载荷也看到 token |
| **仅在 loopback 上的裸 `http://`** | 自身什么都保护不了——攻击模型是同机上的另一个进程，它早已能读配置 | 任何网络跳 |
| **在公开或可路由接口上的裸 `http://`** | **不可接受。** 被动在途攻击者读到 root token 和每一份 handoff；主动攻击者可在没有任何完整性校验的情况下改写 handoff | 一切 |

协议层隧道优于终止 TLS 的边缘，恰恰因为边缘位于信任模型之内：它保护整条链路而不只是线路段，
且不花代码成本。TLS 代理仍可接受。暴露接口上的裸 `http://` 不行。

应用层加密曾被考虑作为额外一层并被**否决**（P1-C）：它只保护 handoff 载荷，而协议隧道连控制面
和凭证也一并保护。叠加它并不会让 TLS 或私有网络变成可选。

## 实测的部署事实

2026-10-17 来自线上部署的观察，作为测量值记录而非保证。

- 经由隧道的一次 gateway 往返约**热 1 s**、**冷 3.5 s**（actor 唤醒）；一次控制面列表约
  **0.7–2.4 s**。对没有活 runner 的 pool 发起请求会等引擎自身的约 30 s ready-wait，然后以
  `guard.actor_ready_timeout` 失败。
- native runner **持续 ping**（整个会话中 `last_ping_ts` 为 1–3 s 前，`last_rtt` 为
  442–831 ms），因此边缘的空闲超时触及不到 runner 注册。不需要客户端心跳。

## 后果

- **就本设计而言，明文是永久的。** 没有后续 ADR，也没有计划中的信封。任何重新审视它的人都应
  先读 P1-C 被否决的理由，而不要假设它被推迟了。
- **冒名顶替保持敞开。** 一个活 pool 里的外来 `xfer-instance` actor 与真实节点无法区分。这是
  P0-B 中本该由信封关上的那一半；如今它是一项被接受的风险，只有部署层面的缓解。
- **面向操作者的说明在指南里**，不在这里：`docs/guides/mesh-setup.md` 承载配置步骤和排障行。
  本 ADR 陈述态势，不重复它们。
- **选择隧道是一个安全决定，不是便利决定。** 仅出站隧道的便利是真实的；它的运营方能读到一切
  也是真实的。在这种取舍上做权衡是操作者的决定，且应当是在知情的情况下做出的。

## 参考

- ADR 0013（mesh 传输）——为什么文档要内联，以及本文所限定的引擎/队列模型。
- ADR 0017（按宿主的 runner pool）——pool 放置，被上面的部署形态引用。
- `docs/guides/mesh-setup.md` ——本 ADR 有意不重复的操作者说明。
- `docs/milestones/notes-mesh-transport-encryption.md` ——底层调查（§1–11），包括对
  `http://` → 明文 WebSocket 的实测检查。
- `docs/milestones/phase3-features.md` ——P1-C 的被否决，本 ADR 依赖于此。
