# Mesh boundary extension — discussion record (thought experiment, not scheduled)

Provenance: xfer handoff `mvbqgtve-idqjvv` (`kind: notification`) from `pi-xfer_t82p`,
machine `ison-arch`, project `pi-xfer`, branch `main`, 2026-10-17. No code was written and the
repo was unchanged at the time of filing. Body preserved verbatim (source language: Chinese);
verification notes appended at the end by the receiving agent.

# pi-xfer 能力边界扩展 — 讨论纪要与方向记录(思想实验,暂不实施)

## Context

与用户(pi-xfer 作者)围绕"扩展 xfer mesh 网络可触达边界"做了多轮讨论。背景:pi-xfer 是 pi coding-agent 的 cross-context handoff 扩展;mesh 传输基于 RivetKit(ADR 0013),非 pi 宿主通过 xfer-adapterd 接入(ADR 0015)。用户接触了 Rivet 的 serverless worker(Cloudflare)、Pi Durable(Earendil 的 durable harness)、PiDurableKit(iOS/JSC 移植)后,提出若干接入设想。

## 讨论结论(已达成共识)

1. **CF + Pi Durable actor 可作为 mesh 上的普通节点(最有价值的方向)**
   - 机制:serverless pool 承载一个 `xfer-instance` 实现,桥接到 Durable Object 内的 Pi Durable harness;寻址沿用 actor type + key,发送端不带 poolName 即可跨 pool 投递。
   - 已确认可行性依据:文档内联(ADR 0013)使 CF 端无需落盘;serverless 为纯 JS 不触发 native addon 约束;durable queue 支持 sleeping actor 唤醒;handoff id → requestId 天然 exactly-once。
   - 纪律:收 task 应"领走就回"(submit 不等待);跨调用无内存态,回信所需信息须写入 actor SQLite(documents);对离线缓冲是好目标、不是好来源。
   - 注意:被 ADR 0013 否决的是"引擎侧常驻 runner",serverless pool 是不同 pool kind,不在否决范围内;但引擎需公网可达(control plane 主动回调 worker),是部署形态的改变。
   - 用户设想的首个用例:定时唤醒搜集网络热点、记录总结;认为有价值时通过 mesh 通知常驻 agent 写入 Obsidian(做法 A:常驻 pi 真正在线,非唤醒沉睡 pi —— 后者目前不存在,in-process actor 语义决定)。
   - 关键洞察:CF agent 的红利不是"可达"而是"存在方式"—— mesh 上出现第一种不需要供养的节点,有事才醒。

2. **手机(原生 app)只能当 client / 输入源,不适合作为 agent actor**
   - iOS 无 native addon(rivetkit envoy 必须 native,wasm 被禁止),PiDurableKit 证明 pi-durable 本身可脱离 Node(JSC + Swift polyfill),但 runner 装不进 iOS。
   - Android Termux = 完整 Linux,可直接跑现有 adapterd,但被用户排除(能跑 Termux 就能跑完整 pi + 插件)。
   - 手机定位:纯 push 输入源(传感器 = 具身信息),agent 无 read-side(对比 web-picker 有实时查询能力);源自 ADR 0007"人类亲手操作是最高保真执行者"的同构推理。
   - 可能的增强:持久化提问回路(agent 经 Board 提问,人下次打开手机回答),SLA 是"下次有人用手机",推送不可靠是语义而非 bug。当前仅为思想实验。

3. **最小验证路径(若将来实施)**
   - engine 公网暴露 + CF 上空 `xfer-instance`(serverless pool)+ 本机 `mesh send` 进去 + 原样 `mesh send` 回来。不写任何 agent 逻辑,先验证"CF 是不是网络里的普通节点"。
   - 需要 escape hatch:`mesh-engine.ts:199` 的 `getOrCreate` 目前无条件钉 config.pool,跨 pool 发送需显式处理;adopted actor 不因 poolName 搬家(mesh.ts:208)。

## Problem to solve

本次 handoff 为**记录性传递**:把以上讨论结论归档到 milestone 侧,作为后续真正实施 CF actor 接入时的背景输入。无待解问题。

## Requirements

- 无具体交付要求;作为 context 存档即可。
- 相关 ADR:0013(mesh transport)、0015(adapter daemon,含 deferred 的 `url` strategy —— 本次讨论给出了它的研究结论)、0016(adoption)、0017(per-host pools)、0018(handoff kind)。
- 相关外部资料:rivet.dev serverless workers 文档、rivet.dev/agents/docs/pi、earendil.com/posts/pi-durable/ 与 /pi-durable-on-cloudflare/、github.com/finnvoor/PiDurableKit。

## Kind

notification — 仅告知/存档,无需结论回复。

## Return address

from: pi-xfer_t82p(notification,无需回信)

## Notes

- 所有结论均为思想实验阶段,未写任何代码,repo 无改动。
- 若 milestone 侧已有 CF/pi-durable 相关的后续规划,可基于上述"最小验证路径"直接展开。
## Verification notes (receiving agent, 2026-10-17)

- `mesh-engine.ts:199` — the claim "unconditionally pins `config.pool`" is slightly off: the
  `getOrCreate` pool pin is guarded by `config.pool` (unpooled when absent). The stated
  consequence still holds: there is no code path that deliberately addresses another pool, so a
  cross-pool send needs an explicit escape hatch.
- `mesh.ts:208` — confirmed: `assertPoolMatch` documents that an adopted actor keeps its
  original pool placement; `getOrCreate` with a different `poolName` does not move it.
- ADR 0015 still lists the `url` strategy as deferred; this record is the research conclusion
  for it (phone/native hosts cannot run the runner; they are push-only input sources).
- ADR 0013 forbids an engine-side always-on runner; a serverless pool is a different pool kind
  and therefore not covered by that rejection — but it requires the engine to be publicly
  reachable, which is a deployment-shape change, not a config flag.
- Not yet checked: RivetKit serverless-worker support in the pinned rivetkit version, and
  whether `client.getOrCreate` / queueSend can reach a serverless-pool actor without a
  `poolName`. Both belong to the design node if this item is picked up.
