> 中文版 · 英文原文：[phase4-design-p0-p1.md](phase4-design-p0-p1.md)

# Milestone 4 design — 条目 0 + 1(存在感信号、Handoff outcome)

> Design 节点,2026-10-19。条目 0 和 1 在设计讨论中合并为一次改动;这是该改动的
> 书面计划。决定记录:ADR-0020。
> `phase4-features.md` 的条目 2–5 不受它影响 —— 见下方「这留下了什么」。

## 这两个条目变成了什么

`phase4-features.md` 把条目 0 排在条目 1 之前,并把 0 设为前置条件(「一个复述已知会说谎的
信号的判定,比没有判定更糟」)。那个排序是假设的,不是推导出来的。一旦把两个轴分开,
条目 0 的四个缺陷就落在不同的轴上,其中只有一个作为承重项存活:

| 缺陷(来自特性清单) | ADR-0020 之后的轴 | 仍然需要? |
|---|---|---|
| `index.ts:209` — `agent_end` 在 run 结束前就置 `idle` | Node(发布的元数据) | **不需要。** local 的 Node 轴是退化的;mesh 的预检读 actor 记录,不读 `status`。 |
| `adapterd.src/daemon.ts:88` — 启动时写一次 `status: "idle"` | Node(发布的元数据) | **不需要。** 同上理由。 |
| `XferInstanceState` 没有 `status` 字段 | Node(mesh) | **不需要。** mesh 的预检从 actor 记录与 `/envoys` 结合推导可达性。 |
| `state.ts:75` — `isRuntimeIdle()` 从不询问 `hasPendingMessages()` | Handoff(`controller.ts:32,69-70` 处的 steer/followUp 分支) | **需要。** 没有它,一个排在排队轮次之后的 Handoff 会虚假报告 `delivered`。 |

再加上清单归在条目 0 之下但未裁定的第二个更安静的缺陷 —— 本地重名 —— 它
结果是 local 本来退化的 Node 轴上**唯一**的洞,因此最终仍在范围内。

所以条目 0 = 两个前置条件。条目 1 = 那次改动。两者是一个 commit。

## Q1 —— 两个轴,不是一个词

`CONTEXT.md` 已经把 *Delivery verdict* 固定为列表对某一个 **Node** 的断言
(`mesh-status.ts` 把它渲染成七个字形)。条目 1 想要的是对某一份 **Handoff** 的断言。
两者正交,而且两边的界面在相反的轴上丰富:

```
                     Node axis                    Handoff axis
                (can it receive at all)      (where did this one land)
              ┌────────────────────────┐    ┌────────────────────────┐
  mesh        │ 7 glyphs + fail-closed │    │ not-delivered          │
              │ preflight + delivered[]│    │ unknown | failed       │
              │  → rich                │    │ + delivered[] window   │
              ├────────────────────────┤    ├────────────────────────┤
  local       │ endpoint exists ⇔ can  │    │ one constant           │
              │ receive → degenerate   │    │   status: "sent"       │
              └────────────────────────┘    └────────────────────────┘
```

两个术语,现在都进了 `CONTEXT.md`。*Handoff outcome* 有意避开 `receipt` 和
`acknowledgement` —— 它们已在 **Handoff** 条目的避免清单上,而且在线路上已被
ack frame 和 `delivered[]` 占用。

## Q2 —— 取值集合及其上限

有两个事实限定了任何传输能诚实说出的话,而且都不是选择:

- `pi.sendMessage(...): void`(`types.d.ts:1258`)—— 接收方没有返回值、没有
  id、没有错误。它只知道它没有抛错。
- ADR-0015 选择了有损的「拿走即读」Inbox;持久归档在那里被考虑过并
  被拒绝,而 `phase4-features.md` 把「持久读回执」留在 out of scope。

所以 outcome 是传输时刻的断言,绝不是事后回执,也绝不是「是否被读过」。

| 取值 | mesh(发送侧,已存在) | local(发送方合并两个事实) |
|---|---|---|
| `queued` | ✓ enqueue 被接受,会有 runner 取走 | ✗ 这条传输没有队列 |
| `delivered` | ✗ 发送方无法得知这一点 | ✓ ack 随分支事实返回 |
| `unknown` | ✓ enqueue 答复含糊 | ✓ 在 ack 之前连接断了 |
| `not-delivered` | ✓ `actor_ready_timeout` | ✓ `client.ts:16` 无此端点 |

两边同样四个取值,各自覆盖一个子集。这种不对称是 ADR-0015 的,用
文字写明而不是抹平。

**边界,按用户的明确约束:** 这是代码级 ack,不触碰 `kind` 设计。没有 pending
记录、没有等回复、没有超时、没有回复通道 —— 一个 `notification` 可以 `delivered` 而
永不被回答,一个 `task` 可以 `delivered` 而永不被结案。那个缺口是条目 4,不是本次改动。

## Q3 —— local 不做预检

`preflightMeshSend` 存在是因为 mesh 的 Node 轴很丰富:「在线但其 pool 没有
runner」在那里真实且常见,漏检要花 30 秒 enqueue,读起来像「也许投递了」。local 两者皆无。
它的 Node 轴只有两个状态,`client.ts:16` 已经检查了唯一可能失败的那个,而一次误判通过
只花一次连接失败加一次 `unlink`(`index.ts:126`)—— 什么都不会残留。所以 local
不新增预检;mesh 不受影响。

## Q4 —— bind 时的活跃/僵尸判别

`controller.ts` 和 `adapterd.src/daemon.ts` 在 bind 之前 unlink 端点。这让
`EADDRINUSE` 不可达,从而让现有的错误路径(`server.ts:57-59` →
`controller.ts:136-143`)不可达。后果:两个同名的 pi session 都能成功 bind;
第一个被困在一个已 unlink 的 inode 上,再也无法被连接;**两者写同一个 `<name>.json`**,
于是 `/xfer list` 显示一个 peer,其 `pid` 来回交替。`hasLivePeer()`(`index.ts:50-57`)对
两个 pid 都成功,所以 `xfer_to` 保持常驻,模型被告知从 `/xfer list` 取名。

两个文件里共有八处 `unlinkSync`,一句话就能把它们分开:
**释放*我们自己的*名字的 unlink 是对的;清除*别人的*占用的 unlink 是 bug。**

| 位置 | 判定 |
|---|---|
| `controller.ts:98-99` — `start`,它即将占用的端点 + 元数据 | **必须去掉** → 改为判别 |
| `controller.ts:141-142` — `rename`,它即将占用的**新**端点 + 元数据 | **必须去掉** → 最糟的一处:在活跃 session 上执行 `/xfer name foo` 会静默抢走 `foo` |
| `adapterd.src/daemon.ts:76` — `start`,陈旧 socket | **必须去掉** → 改为判别 |
| `controller.ts:135-136` — `rename`,释放它原本持有的旧名字 | 保留 |
| `controller.ts:163-164` — `shutdown` | 保留 |
| `adapterd.src/daemon.ts:186-187`、`:198-199` — shutdown | 保留 |

修法:把三处占用替换为一次判别。

这正是 local 退化 Node 轴上唯一的洞:`client.ts:16` 通过,连接成功,
`delivered` 回 true —— 但那是一个并非被指名者的 Node。

```text
endpoint exists
  ├─ live (metadata pid alive, or socketHasListener) → bind fails, say so
  └─ crashed                                        → remove, then bind
```

两个谓词都已存在并在 `gc.ts` 中测试过(`processAlive`、`socketHasListener`),
并且带着要紧的保守语义:`EPERM` 算作存活,连接超时算作在监听。这把 gc 的规则从手动的
`/xfer gc` 移到 bind 时。当前的 unlink 侍奉两个主人 —— 清僵尸*以及*让重名
接管 —— 两者必须拆开。

行为变化,直说:在同一目录启动第二个同名的 pi,从静默接管变成
带消息的启动失败。这是一个真实的权衡(「静默接管 vs. 拒绝启动」),这正是 ADR-0020
记录它的原因 —— 但实现很小、易于回滚,所以没有为它单独写 ADR。

## 改动

```diff
  // state.ts — prerequisite 1
  isRuntimeIdle(): boolean {
    if (!this.runtimeContext) return true;
-   try { return this.runtimeContext.isIdle(); } catch { return true; }
+   try {
+     const ctx = this.runtimeContext;
+     return ctx.isIdle() && !ctx.hasPendingMessages();
+   } catch { return true; }
  }

  // controller.ts + adapterd.src/daemon.ts — prerequisite 2
- try { fs.unlinkSync(endpoint); } catch { /* ok */ }
+ // endpoint present → live: fail the bind and name the conflict;
+ //                   crashed: remove and bind.
+ // Reuse gc.ts processAlive() / socketHasListener().

  // server.ts — the receiver's half
- socket.write(JSON.stringify({ type: "ack", msg_id: msg.msg_id }) + "\n");
+ socket.write(JSON.stringify({ type: "ack", msg_id: msg.msg_id, outcome: "delivered" }) + "\n");

  // client.ts + broker-main.ts — the sender's merge
- const ack = response as { type?: unknown; msg_id?: unknown };
- if (ack.type === "ack" && ack.msg_id === msg.msg_id) { finish(); return; }
+ const ack = response as { type?: unknown; msg_id?: unknown; outcome?: unknown };
+ if (ack.type === "ack" && ack.msg_id === msg.msg_id) {
+   finish(undefined, ack.outcome === "delivered" ? "delivered" : "unknown");
+   return;
+   // no field (older receiver) → unknown, never delivered
+ }

  // index.ts — the constant goes away
- status: "sent"
+ outcome: <queued | delivered | unknown | not-delivered>
```

在既有 frame 上做加法:没有新 frame 类型、没有新端点、没有协议版本。
两个读取方本来就会忽略未知字段。

## 涉及范围

| 文件 | 改动 |
|---|---|
| `state.ts` | `isRuntimeIdle()` 询问 `hasPendingMessages()` |
| `controller.ts` | 三处占用点改为判别:`:98-99`(`start`)、`:141-142`(`rename` 的新名字) |
| `adapterd.src/daemon.ts` | `:76` 处相同 —— peer 必须行为一致 |
| `server.ts` | ack frame 携带 `outcome` |
| `client.ts` | 读取 `outcome`,从 `sendNotify` 返回它 |
| `broker-main.ts` | 转发路径上做同样的合并(`:318-319`) |
| `types.ts` | `XferNotifyOutcome` 联合类型;若在列表中出现,则 `PeerInfo`/`TargetInfo` |
| `client.ts` | `sendNotify` 返回 `Promise<XferNotifyOutcome>` 而不是 `Promise<void>` —— 三个调用方:`index.ts:118`、`adapterd.src/main.ts:189`(CLI 的 `send`)、以及 `adapterd.test.ts` |
| `index.ts` | 两个工具报告 `outcome` 而不是 `status: "sent"` |
| `gc.ts` | 无改动 —— `processAlive`(`:43`)和 `socketHasListener`(`:60`)已导出,且语义正好够用 |
| `server.test.ts` | `:86` 用 `deepEqual` 钉住 ack 形状 —— 唯一断言线格式的地方 |

无构建产物变化(`web-picker.user.js`、`mesh-runtime.cjs`、`broker.cjs`、
`admin.cjs` 均未触碰)。无新依赖。不偏离 ADR-0013/0014/0015。

## 风险

1. **如果前置条件 1 单独上线,`delivered` 就是谎言。** 两者必须一起落地 ——
   否则一份排在待处理轮次之后的 Handoff 会报告成功。
2. **重名上的行为变化。** 任何依赖静默接管的人 —— 第二个同名 pi,或把
   `/xfer name foo` 指向活跃的 `foo` —— 现在会得到启动错误。这是
   有意为之的修复;在此特别说明,因为它是本次改动中唯一用户可见的回归。
3. **ack 字段是相对旧 peer 的线格式变化。** 按 fail-safe 处理(字段缺失 → `unknown`),
   但混合版本的集群在本地发送时会报告 `unknown`,这是正确的,但在仪表盘上
   看起来像回归。
4. **这里没有任何东西可以对着真实部署测试**(AGENTS.md)。测试使用
   `fakeDeps` / loopback 引擎;重名路径尤其需要一个在同一路径上 bind 两个
   server 的测试,而这是密封的。
5. **`unknown` 规则很容易被侵蚀。** 任何未来暗示对 `unknown` 重试的文案,
   都会重新引入该取值本来要防止的重复危险。

## 这留下了什么

- **条目 2(MCP 出站)** —— 不受影响。落地时它从同样的四个取值里选。
- **条目 3(入站 hold/refuse)** —— 按指示停在 design 节点。ADR-0020
  记录了它必须决定的一件事:`held` ≠ `queued`,所以它需要第五个取值。
- **条目 4(循环守卫)** —— **不能建立在 outcome 上。** Outcome 是传输时刻的,对回复
  沉默;而守卫问的是一个 `task` 是否曾被结案,那属于语义层。它需要自己的
  基础,而研究轮遗留的开放问题(Board 的单一 `pending` 槽位、pi 内部 steer 的
  并发排序)正是那个基础必须来自的地方。
- **条目 5(逐主机 profile)** —— 未触碰,仍只是范围。

## 验证

在 `8a334be` 中实现。`npm test` 539 通过,0 失败(改动前是 521)。

新增测试:`client.test.ts` 覆盖 ack 合并 —— 只有接收方这么说才 `delivered`,
字段缺失或无法识别时为 `unknown`,连接先死时拒绝。`endpoint-claim.test.ts` 覆盖
本可以抓住那次接管行为的规则:活跃 peer 被拒绝且其文件存活,崩溃残留被清除。三个路由
用例钉住 `isRuntimeIdle()`(空闲 + 无排队 → `followUp`;空闲 + 有排队 → `steer`;
忙 → `steer`),而 `server.test.ts` 的 ack 形状现在断言新字段。

人工冒烟,2026-10-19,仅本地(`--no-mesh`、无引擎、`mesh.config.json` 从未
读取):

| 内容 | 结果 |
|---|---|
| `xfer_to` → 同机器上一个活跃的 `xfer-adapterd` | `✅ delivered`,且记录在 daemon 的 `inbox.jsonl` 里 —— 该断言是真的,不只是一个返回值 |
| 接收方晚 8 秒 ack,客户端 5 秒超时 | 以 `ack timeout` 拒绝 → 走 `unknown` 分支(「不要重发」),不是 `not-delivered` |
| 在活跃名字上再次 `xfer-adapterd up --name` | 以活跃 peer 的名字拒绝,退出码 1,第一个 daemon 不受影响 |
| 死 pid + 未接受 socket(崩溃残留) | `nameIsLive` 为 false → 两个文件都被清除 → 名字可复用 |

prompt 侧的措辞自我校验:被问到它发了什么时,该 session 用工具的 `delivered` 作答,
**并且**主动补充了「delivered 只表示已交到目标会话，不代表它已读取」,
这正是设计放进结果文本里的那句话。

Admin 和 `commands.ts` 的流程未被本次改动触碰,所以 `verify` skill 的浏览器
通道不适用。
