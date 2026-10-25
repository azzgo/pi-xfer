> 中文版 · 英文原文：[0009-xfer-board-command-driven.md](0009-xfer-board-command-driven.md)

# Xfer board：Markdown 卡片、由人下令、以 prompt 注入写入

状态：accepted

## 背景

xfer 扩展在会话之间搬运 handoff，但跨项目的异步协作一直没有落脚点：agent 的发现和悬而未决
的问题随着它的会话一起消失，而能帮上忙的 agent 在需求出现时往往已经离线。想要的协作模型
刻意做得很克制——一张由话题组成的共享面，任何 agent 都可以*被人派去读写*，既不需要活的
peer 连接，也不需要 agent 之间的消息协议。

有三个决策当时确实存在备选方案：

1. **存储格式。** JSONL/SQLite 提供廉价的索引和原子更新，但产出的都是不透明的大块：人和
   agent 都离开工具就看不懂一张卡片，而可复查的审计轨迹（谁在何时说了什么）恰恰是讨论板
   的意义所在。
2. **谁驱动读写。** 最显而易见的 agent 原生设计是注册 `board_read` / `board_write` 工具，
   让 agent 自主使用 board。这被否决了：操作者希望自己是跨 agent 通信的唯一协调者（agent
   在线时已经通过既有的 xfer handoff 协议直接对话），而注册更多工具会扩大操作者必须推理的
   面。
3. **agent 撰写的条目如何落到卡片上。** 没有工具，斜杠命令处理器（确定性代码，无 LLM）无法
   判断条目类型，也无法把"把你刚才的结论记到卡上"提炼成一条 Entry——但它可以注入一段
   prompt 并拦截回复。

## 决策

- **一张卡片一个 Markdown 文件**，位于 `~/.pi/xfer/board/`
  （`c-XXXX-slug.md`）：类 YAML 的 front matter（id/title/created_by/created_at），
  加一个只追加的正文，由 `### e-XXXX · type · author · timestamp` 小节组成。agent 和人
  直接读这个文件；`read` 原样注入它；复查就是打开那个目录。
- **仅由命令驱动。** 所有 board 操作都在 `/xfer board …` 之下。没有
  `pi.registerTool`。agent 永远不会未经提示去碰 board；由人来编排（在一个会话里 `read`，
  在另一个会话里 `write`，或者对在线 peer 用 `/xfer <target>` 派发）。
- **两阶段写入：prompt 注入 + `agent_end` 拦截。**
  `/xfer board write <id> <intent>`（以及无标题的 `new`）会存下一个待定目标，注入一段
  prompt，要求 agent *只*回复一个围栏的 ```board-entry``` 块（新卡片的 title、type、
  `---`、markdown 正文）；`agent_end` 处理器解析这个块，追加 Entry，并清除待定状态。
  格式不符的回复会带警告中止——不会写进半截东西。
- **卡片是无状态的。** 没有生命周期状态、没有指派人、没有定时器。
  `del`（单张卡片，需确认）和 `clean`（所有卡片，需确认）是仅有的清理路径，都由人发起。
  条目类型（note/finding/question/answer）只是标签，不是逻辑。

## 后果

- board 天然可检视（`ls ~/.pi/xfer/board`、`cat`、`grep`），复查入口就是文件系统本身
  （`/xfer board open`）。
- 跨会话协作的延迟下限是每跳一次人的往返；用于讨论/分析可以接受，用于紧循环则不对——那种
  场景应当改用实时的 `/xfer` handoff。
- 围栏块协议是约定，不是 schema：如果 agent 无视它，写入会大声失败，而不是弄坏一张卡片。
  未来一个 `registerTool` 开关可以在不碰存储格式的前提下替换它。
