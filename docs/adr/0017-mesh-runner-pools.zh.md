> 中文版 · 英文原文：[0017-mesh-runner-pools.md](0017-mesh-runner-pools.md)

# 按宿主划分的 mesh runner pool

状态：accepted

## 背景

mesh（ADR 0013）是一个共享引擎，每个 Node 一个 actor。RivetKit 的 runner 放置是 pool 作用域
的：加入某个 pool 的 runner 只会接收 `runner_name_selector` 与之匹配的 actor。pi-xfer 最初
不设 pool，于是每台宿主的 runner 都加入引擎级的 `default` pool，任何宿主都可能接收到任何
actor。

在单机上这看不出来。在一个混合机群的 mesh 上——一台 grok bot、一台 issue-tracker 机器、几台
开发用 Mac——它会产生真实的错投：引擎把节点 A 的 actor 调度到宿主 B 的 runner 上，发给节点 A
的 handoff 就投递到了宿主 B。一位 mesh 用户报告的正是这种情况（"lookback"：handoff 出现在
了错误的机器上）。"节点名"寻址的是 actor，但默认情况下没有任何东西钉住这个 actor 在*哪里*
运行。

## 决策

按宿主的 pool，通过 `MeshConfig.pool` opt-in：

- 当配置设置了 `pool` 时，`setup()` 携带 `envoy: { poolName }`，于是**本宿主的 runner 加入
  它自己的 pool**。
- 自身 actor 的 `client.getOrCreate(XFER_INSTANCE_ACTOR, [name], { poolName })` 携带该
  pool，于是**本 Node 的 actor 在该 pool 中创建并从该 pool 解析**——只有这台机器会被调度来
  运行它。
- 一切触及*其他*节点的东西保持不设 pool：`listNodes()` 是不加过滤的引擎列表，
  `queueSend`/`getDescription` 使用 `client.get`（不创建），因此另一个 pool 里的 Node 仍然
  可被发现、可被寻址。只有我们自己 actor 的放置被钉住。
- 不设 `pool` 时逐字节复现先前的调用形态：没有 `envoy` 块，`getOrCreate` 只传 name + key。
  默认行为不变。
- adapter daemon 以 `--pool` 暴露同一个值，与 `--engine/--namespace/--token` 对应
  （ADR 0015）。

pool 的创建**不**从客户端自动化：引擎在接收 runner 之前需要每个 pool 的 runner-config，这仍
是 [docs/guides/mesh-setup.md](../guides/mesh-setup.zh.md) 中文档化的一次性
`PUT /runner-configs/<pool>?namespace=<ns>` 调用。

## API 证据（rivetkit 2.3.26，已锁定）

文件 `node_modules/rivetkit/dist/tsup/config-Cv6pjCt-.d.ts`：

- `setup()` 配置携带 envoy/runner pool（第 185 行）：
  ```ts
  envoy: z$1.ZodDefault<z$1.ZodOptional<z$1.ZodObject<{
      poolName: z$1.ZodDefault<z$1.ZodString>;
      version: z$1.ZodDefault<z$1.ZodNumber>;
      totalSlots: z$1.ZodDefault<z$1.ZodNumber>;
      envoyKey: z$1.ZodOptional<z$1.ZodString>;
  }, z$1.core.$strip>>>;
  ```
- 公开的 `getOrCreate` 接受按调用覆盖 pool（第 1742 行）：
  ```ts
  getOrCreate<AD extends AnyActorDefinition>(name: string, key?: string | string[], opts?: GetOrCreateOptions): ActorHandle<AD>;
  ```
- `GetOrCreateOptions.poolName`（第 1643–1646 行）/ `CreateOptions.poolName`
  （第 1659–1662 行）：
  ```ts
  /**
   * Name of the envoy pool to select for this actor if it is created.
   * Overrides the client's configured `poolName` for this call.
   */
  poolName?: string;
  ```
- `CreateRequestSchema` 在引擎侧携带 `poolName`（第 33 行），
  `GetOrCreateWithKeyInput`/`CreateInput` 都把 `poolName` 记为
  "Overrides the client's configured pool name for this actor"（第 559、569 行）。

文件 `node_modules/rivetkit/dist/tsup/chunk-LEXBAJ2Q.js`（该调用最终变成的引擎请求）——
第 6053 行：

```js
runner_name_selector: poolName ?? this.#config.poolName,
```

也就是说，按调用的 `poolName` 落进创建请求的 `runner_name_selector`，这正是 runner 的
`envoy.poolName` 必须匹配的东西。客户端配置的默认 `poolName` 是
`getRivetPool() ?? "default"`（第 5156、5209 行），证实改动前的行为就是共享的 `default`
pool。

## 后果

- 发给某个 Node 的 handoff 会在该 Node 所在的宿主上投递，即使多台宿主共享一个引擎，因为引擎
  只能把 actor 调度到匹配 pool 里的 runner 上。
- 混合机群每台宿主多付一次性的 `runner-config`。这就是取舍：每台机器多一个控制面对象，换取
  正确的投递局部性。
- 按宿主的 pool 是放置保证，不是数据或命名空间的隔离——`namespace` 语义未受影响且相互正交。
- 没有 runner-config 的 pool 什么都不接收；症状是一个能连上但永远启动不起来的 Node。已在指南
  中记录。

## 参考

- ADR 0013（mesh 传输）——引擎与 crash-policy/sleep 模型。
- ADR 0015（adapter daemon）——获得 `--pool` 的第二个宿主。
- `docs/guides/mesh-setup.md` ——按宿主的 pool 配置。
