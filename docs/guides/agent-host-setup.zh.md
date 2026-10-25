> 中文版 · 英文原文：[agent-host-setup.md](agent-host-setup.md)

# Agent 宿主配置 —— 把一个非 pi 的 bot 接入 xfer 网络

本指南面向一个**不是** pi 会话的 bot 或 agent——飞书 bot、CLI agent、cron worker——
它应当像任何 pi 节点一样收发 xfer handoff。Adapter Daemon（`xfer-adapterd`）就是那座
桥；每个 bot 不需要专门的 adapter 代码。这里的一切适用于任何宿主，并以 grok bot 作为
示范例子。

如果你的“宿主”是一个 pi 会话，你不需要本指南——见
[快速开始](quickstart.zh.md) 与 [Mesh 配置](mesh-setup.zh.md)。

## 各部分如何配合

```
mesh engine (durable queue)
        │  push — the engine delivers to your node's actor
        ▼
xfer-adapterd  (one per host, named like a pi node)
        │                    │
        ▼ push                ▼ pull
--on-handoff CMD       inbox take/list (JSONL)
  (your command gets      (your bot polls a
   the handoff on stdin)   local inbox file)
```

- **Mesh → adapterd 是 push。** 引擎的持久队列在入站 handoff 到达时就把它们投递给
  守护进程的 actor。你的 bot 从不轮询引擎。
- **adapterd → 你的 bot 由你选择**：通过 `--on-handoff` push，或通过 inbox pull。
  选一个；也可以两个都用（inbox 总是记录每一份 handoff，`--on-handoff` 是叠加在上面
  的额外策略）。

## 1. 安装守护进程与 skill

```bash
xfer-adapterd install --host generic --into /path/to/your-bot --name grok
```

这会把通用的 agent-host skill（SKILL.md + 辅助脚本）复制到 bot 的目录，好让 bot 知道
如何发送和取走 handoff。生成的启动命令是**仅本地**的——本机上的一个 Unix socket。
如果 bot 还需要跨机器可达，在 install 时加上 `--mesh`。

## 2. 配置 mesh（仅当 bot 加入集群时）

像 pi 节点一样创建 `~/.pi/xfer/mesh.config.json`：

```json
{
  "endpoint": "https://engine.example.com",
  "namespace": "default",
  "token": "…",
  "pool": "grok-host"
}
```

然后确认这套配置真的能用——下面这一条命令会解析配置、在引擎上按需创建该 pool 的
runner-config，并确认可达性：

```bash
xfer-adapterd up --mesh --name grok --once   # smoke: joins and exits after first handoff
```

或者，在同一台机器的 pi 会话里运行 `/xfer mesh setup`（同一个配置文件、同一个引擎）。
注意：

- **每个宿主选一个 pool**，用机器名。见
  [per-host pools](mesh-setup.zh.md)。已存在的 actor 不会自己换 pool——如果你之后改了
  `pool`，遵循[迁移警告](mesh-setup.zh.md)（down、重启、up）。
- 凭据放在它们**各自的字段**里——`namespace` 和 `token`。URL userinfo
  （`https://ns:token@host`）会被拒绝并给出迁移提示：一个 URL 携带
  多项设置太容易出错。`token` 可以是字面量、`$VAR` 或 `!command`——见
  [不是字面量的值](mesh-setup.zh.md)。

## 3. 选择投递模式

### Push —— `--on-handoff`

```bash
xfer-adapterd up --name grok --mesh \
  --on-handoff /path/to/your-bot/handle-handoff.sh
```

每一份入站 handoff 都会启动 `handle-handoff.sh`，把 handoff 的 JSON 放在 stdin 上：

```json
{ "id": "h-…", "from": "issue-tracker", "to": "grok",
  "summary": "…", "file": "/tmp/xfer/h-….md", "transport": "mesh" }
```

文档正文在 `file` 处。失败的 handler 永远不会把守护进程带下去；无论哪种情况 handoff
都留在 inbox 里。当你的 bot 应当立刻反应时用这个——例如把摘要发到飞书 webhook、唤醒
agent 循环。

### Pull —— inbox

```bash
xfer-adapterd up --name grok --mesh          # daemon only
xfer-adapterd inbox take --name grok         # bot polls; consumes every pending record (consume-on-read)
xfer-adapterd inbox list --name grok         # peek without consuming
```

inbox 是一个本地 JSONL 文件；`take` 原子地消费掉每一条待处理记录。没有保留期——
读过就没了。对于本来就靠定时器唤醒的 bot，轮询完全够用。

## 4. 往外发送 handoff

```bash
# to a local pi session (same machine)
xfer-adapterd send <target> <file> <summary> --from grok

# across the mesh
xfer-adapterd mesh send <target> <file> <summary> --from grok
```

## 5. 常驻运行

守护进程是一个普通的前台进程；用你已有的手段让它活着：

- **tmux**（最简单）：一个专用会话运行 `up` 命令。一个退出即重启的 watchdog 循环就够了：

  ```bash
  while true; do
    xfer-adapterd up --name grok --mesh --on-handoff …
    sleep 5
  done
  ```

- **launchd / systemd**：`KeepAlive`/`Restart=on-failure`，5 秒重启退避。

如果守护进程无法连上引擎，它会以非零退出——上面的 supervisor
如果守护进程无法启动（配置错误、启动时引擎不可达），它会带错误消息退出——上面的
supervisor 会重启它，这就是重连路径。

## 值得了解的投递语义

- **持久队列缓冲**：曾经在线过、随后离线的目标，会在重新加入时收到它的 handoff。
  **从未**在线过的目标不会被缓冲——发送会在约 30 秒后报错。如果你预期有流量，让你的
  节点保持 `up`。
- **错投防护**：handoff 按节点名寻址；投递给错误节点的 handoff 会被拒绝，而不是被
  悄悄消费掉。
- **配置错误的 pool**：actor 所在的 pool 没有 runner-config 的节点看起来在线，却永远
  收不到任何东西。`mesh setup`（或守护进程的 `--mesh` 启动）加上 per-host pools 可以
  防止这一点；pi 节点上的 `up` 还会直接拒绝 pool 不匹配。

## 飞书作为入站通道

如果 bot 的用户通过飞书给它发消息，记住这些约束：

- **一个 app，一个长连接消费者。** 一个飞书 app 的 WebSocket 长连接（WSClient）
  只能被恰好一个进程消费。如果你的常驻 bot 持有它，另一个使用同一 app 的进程就什么
  也拿不到。推荐的拆分：飞书长连接活在 bot 进程里；它通过 `xfer-adapterd
  send`/`mesh send` 把消息转发进 xfer，而出站 handoff 通过 bot 的 `--on-handoff`
  handler 抵达飞书。
- **事件去重。** 飞书在 ack 丢失时会重投；按事件的消息 id 做去重键。
- **仅 @ 提及接收**（`GROUP_POLICY=mention`）让群 bot 除非被 @ 否则保持安静；如果你
  任何时候退回定期拉取消息列表，就配上水位线（water-mark）。

pi-xfer 内部一等公民的 `feishu` adapter 是刻意推迟的——上面那条约束是必须先写进
文档的部分，而通用路径今天已经可用。
