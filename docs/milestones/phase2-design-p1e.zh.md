> 中文版 · 英文原文：[phase2-design-p1e.md](phase2-design-p1e.md)

# Milestone 2 design — P1-E mesh 节点能力描述

## 决定(2026-10-13,用户)

- 描述存放在节点自己在**引擎上的 actor state** 里 —— 不是
  `mesh.config.json`(那个文件只是机器全局的连接配置)。
- **默认不存在**;由节点自己设置/修改/清除。
- 只提供逐节点的 **describe RPC** —— pi-xfer 提供这项能力(逐节点 set + get);
  列表仍然只给名字。不内置批量扇出:想要完整地图的消费方自己循环 describe 并在本地
  缓存(与「不做调度闭环」同一原则)。调度设计有意留在 out of scope,
  直到用户的 dispatcher 概念成熟。

## 当前机制(已验证)

- 每个节点是一个 actor:`mesh-engine.ts` 里的
  `client.getOrCreate("xfer-instance", [name])`;actor 定义是本地写死的
  (`ensureNode` 里的 `actor({ … })`)。
- 节点列表是一次引擎 HTTP 查询(`GET /actors?name=xfer-instance`),映射为
  `{ name, actorId }` —— 引擎元数据不带自定义字段,所以描述无法搭
  引擎查询的便车;它们必须来自 actor 自身。
- 面向 agent 的目标列表已经存在(`listTargets`、broker 的 `targets` op)—— 那是
  附加描述的自然位置。

## 计划

### 1. Actor state + RPC(`mesh-runtime.src` 的 actor、`mesh-engine.ts`)

- Actor state 增加一个 `description` 字段(默认 `""`)和两个 RPC:
  `set description`(校验:string、trim、长度上限约 500 字符)和 `get
  description`。
- 状态随 actor 持久化在引擎上 —— 节点重启/重连后仍在;离线节点
  保留其描述。

### 2. 设置/清除入口(扩展命令)

- `/xfer desc <text>` 设置本节点的描述;`/xfer desc` 不带参数即清除。
  与 `/xfer name` 同级。要求 mesh 在线;否则给出清晰错误。

### 3. 读取路径

- **逐节点 describe RPC** 是唯一内置的读取方式:调用方指定目标,得到
  `{ name, description }`。列表端点保持原样(只有名字)。
- broker 的 `targets` op(agent 发送流程中必须的发送前查询)为每个条目附加
  description 字段,作为唯一的便利 —— 发送路径上不多一次往返。
  其余都交给消费方自己循环并缓存。

### 4. 文档

- README / guides:节点描述是干什么用的、建议写什么内容(「这个
  agent 处理哪些请求」),以及明确说明路由/调度有意留给
  消费方。

## 涉及范围

`mesh-runtime.src/`(actor state + RPC)、`mesh-engine.ts`(describe 调用)、
`commands.ts`(`/xfer desc`)、`targets.ts` / broker 的 `targets` op(description
字段)、i18n 字符串、测试(actor RPC、命令)、README/guides;重新构建
`mesh-runtime.cjs`。

## 风险

- 离线节点就是没有可达的描述 —— describe RPC 以正常的「目标可能离线」错误
  失败;调用方按未知处理。
- 描述是自我声明且未经核实的 —— 作为路由提示没问题,但文档不应
  承诺更多。
- Actor state 的 API 面必须保持最小;mesh-runtime.cjs bundle 变化 → 走新鲜度
  测试流程。
