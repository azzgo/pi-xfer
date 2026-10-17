# Mesh peer identity — research input (trust boundary of actor-type discovery)

Provenance: xfer handoff `mvbqic9z-9ktjrb` (`kind: notification`) from `pi-xfer_oizx`,
machine `ison-arch`, project `pi-xfer`, branch `main`, 2026-10-17. Read-only code walkthrough;
no files changed at the time. Body preserved verbatim (source language: Chinese); verification
notes appended at the end by the receiving agent.

# pi-xfer mesh peer 识别机制调研（信息输入）

**From**: `pi-xfer_oizx`
**Kind**: notification —— 无需回复，仅作决策输入。
**日期**: 本次会话

## Context summary

pi-xfer 的跨机 mesh 传输底层是 RivetKit engine。同一个 Rivet engine 上可以同时存在多种 actor：普通 actor 应用、RivetKit Agent、Workflow、以及动态 app。用户关心的核心问题是：**`/xfer mesh list` 和发送动作如何识别 peer，会不会把非 agent 的 rivet 实体误当作可通信目标。**

本次调研为纯只读代码走查（未做任何修改）。

## Problem to solve

需要判断现有实现是否会把 Rivet 上的普通 app / workflow / agent 误列为 mesh peer，并评估加固选项。

## 核心发现

**识别 peer 只靠两个常量 + 单段 actor key，没有任何协议握手或身份验证。**

`mesh-config.ts`：
```ts
export const XFER_INSTANCE_ACTOR = "xfer-instance";   // actor 类型名
export const HANDOFF_QUEUE = "handoff";               // queue 名
```

| 路径 | 代码位置 | 识别方式 |
|---|---|---|
| `/xfer mesh list` | `listMeshNodes()` — `mesh-engine.ts:328` | REST `GET /actors?name=xfer-instance`（带 namespace）→ 只取这一种 actor |
| `/xfer mesh up` | `MeshNode.up()` — `mesh.ts:88` | `engine.listNodes()` 找同名 key；`status === "Running"` 则拒绝（防同名抢占）；pool 不匹配则拒绝 |
| 发送 | `queueSend()` — `mesh-engine.ts:250` | `client.get(XFER_INSTANCE_ACTOR, [target]).send("handoff", msg)`，30s 超时 |
| 免注册发送 | `sendMeshHandoff()` — `mesh-engine.ts:294` | 同上，adapterd 的 `mesh send` 用 |
| 接收 | `onHandoff()` — `mesh.ts:230` | 比对 `message.to` 与自身 actor key `selfKey`，不符则 `onMisroute()` 拒收并上报 |

key 序列化由 `serializeMeshKey` / `deserializeMeshKey`（`mesh-config.ts`）处理，反斜杠转义。

## 结论

**Rivet 上的普通 app / workflow / agent 三类 actor 已经天然被隔离。** 因为 `/xfer mesh list` 走的是 `/actors?name=xfer-instance` 过滤，其他 actor 类型的实体根本不会出现在列表里；发送也永远寻址不到它们。

## 残留风险（真实但需明确边界）

隔离依赖的是「actor 类型名」这一个约定，而非身份或凭据。在**同一 engine + 同一 namespace + 同一 token** 下，任何持有 token 的 Rivet 客户端只要满足其一：

1. 自己 `setup({ use: { "xfer-instance": ... } })` 注册同名 key 的 actor；或
2. 直接调 REST `PUT /actors/...` 造一个 key 为 `["bob"]` 的 `xfer-instance` actor，

就会出现在 `/xfer mesh list` 中，并**真实收到**发给 `bob` 的 handoff 文档——正文明文躺在对方的 `handoff` queue 里。

现有 `XferInstanceState` 只有 `{ description: string }`，无协议版本、无身份字段。`description` 是自述文本，不是认证凭据。

另一个可观测问题：target 不存在 / 非 agent 时，当前只能在 30s enqueue 超时后才报错，且错误文案是 "target may be offline or stuck"，对「目标根本不是 xfer agent」没有区分。

## 加固选项（按成本递增）

1. **协议标记** — actor state 增加 `protocol: "pi-xfer/1"`，list/describe 时读出并标记不匹配者（不显示或标灰）。
   - 成本最低。但 state 可自填，只防误配、不防恶意。
2. **发送前校验** — `queueSend` 前先 `client.get(...).action({ name: "getDescription" })` 探测目标，失败即报「target is not a pi-xfer agent」。
   - 顺带把 30s 超时的慢失败变成毫秒级失败。
3. **独立 namespace / token** — `mesh.config.json` 的 `namespace` 只供 xfer 使用，engine 上其他 app 走别的 namespace。
   - 这是唯一真正的隔离边界，前两层本质都是约定。

## 建议

倾向 **2 + 1 一起做**（2 改善错误信息并实现「只对真 agent 发送」，1 作为 2 的载体提供判定依据）。3 属于部署纪律层面，代码上无法强制，可作为文档要求。

## Relevant files / code references

- `mesh-config.ts` — `XFER_INSTANCE_ACTOR`、`HANDOFF_QUEUE`、key 序列化、config 解析
- `mesh-engine.ts` — `createRivetEngine()`（`listNodes` / `queueSend` / `setDescription` / `getDescription`）、`listMeshNodes()`、`sendMeshHandoff()`、`ensureRunnerPool()`
- `mesh.ts` — `MeshNode` 类：`up()`（Running 冲突拒绝 / pool 校验）、`down()`、`describe()`、`send()`、`onHandoff()` / `onMisroute()`
- `commands.ts:380` 起 — `/xfer mesh list|setup|down|<target>` 的命令分支
- `index.ts:156` 起 — `xfer_mesh_to` 工具定义
- `doctor.ts:184` — mesh engine 可达性检查，复用 `listMeshNodes`
- `admin-main.ts:126` — admin 控制台复用 `listMeshNodes`

## Suggested skills

- `archify` — 若要把这条 mesh 数据流（discovery → enqueue → deliver）画成时序图放进 ADR 或文档
- `verify` — 若实施选项 2，需按项目约定验证 `/xfer mesh list` 与 `xfer_mesh_to` 的实际交互行为

## Notes

- 本次调研未修改任何文件，未运行测试。
- 项目 ADR（`docs/adr/`，尤其 mesh transport 那篇）已定「bundle + on-demand native runtime, engine-side discovery」为既定决策，本调研是在其框架内的加固评估，不涉及推翻。
- `mesh down()` 是唯一会 destroy actor 的路径（销毁会丢弃排队中的 handoff 与 description），这一点在设计任何校验逻辑时要注意不要误触发。

## Verification notes (receiving agent, 2026-10-17)

All load-bearing claims hold up against the tree:

- `mesh-config.ts:17,20` — `XFER_INSTANCE_ACTOR = "xfer-instance"`, `HANDOFF_QUEUE = "handoff"`.
  Confirmed: peer identity == actor type name + single-segment key. No handshake, no credential.
- `mesh-engine.ts:16-19` — `XferInstanceState` is `{ description: string }` only. No protocol
  version, no identity field. Confirmed.
- Discovery filters to one actor type only (`listMeshNodes` → `GET /actors?name=xfer-instance`,
  `mesh-engine.ts:326-333`), so other Rivet actor kinds never appear. Confirmed.
- Send paths are `queueSend` (`mesh-engine.ts:229-233`) and `sendMeshHandoff`
  (`mesh-engine.ts:264-279`), both `client.get(XFER_INSTANCE_ACTOR, [target]).send("handoff", …)`
  with a 30 s `QUEUE_SEND_TIMEOUT_MS` (`mesh-engine.ts:126`). The cited line numbers in the
  original table are stale by ~20-30 lines; the code is as described.
- Slow-failure text confirmed at `mesh-engine.ts:237,279`: "target may be offline or stuck" —
  indeed indistinguishable from "target is not a pi-xfer agent".
- `mesh.ts:143-159` — `down()` is the only destroy path; `up()` adopts non-Running actors and
  never destroys. Confirmed, and relevant to any pre-send probe: a probe must not disturb the
  target's durable state or queue.
- Not checked: whether a `getDescription` probe on a foreign `xfer-instance` actor can throw in a
  way that is distinguishable from a plain offline target (matters for the option-2 error text).

No repo doc currently covers this trust boundary — a decision here will need an ADR (or an
explicit "accepted risk" note in the mesh-transport ADR), not just this file.
