> 中文版 · 英文原文：[0022-page-tool-explicit-tab-routing.md](0022-page-tool-explicit-tab-routing.md)

# 0022 — Page-tool 永远指向一个明确的标签页；广播兜底已移除

Page-tool 的路由过去靠猜（根据最近一次 `annotation.submit` 得到的 `latestTabIdByTarget`），
猜不中时就静默地向所有标签页广播——这是 agent 最终落到错误页面并盲目重试的主要原因。每个入站
连接都在 `hello` 时声明自己的页面生命周期标签页 id，而每一次 submit/bag 条目都携带
Provenance，因此来源标签页永远是一个已知事实，绝不是猜测。决定如下：

- `page-tool` 要求显式的 tabId；找不到就是直接连接式的错误（没有 `unknown_tab` 与
  `tab_disconnected` 的分类法——id 无法解析是解析器的事，无法触达该标签页就只是"连接失败"）。
- submit 的 ack 携带 `routedTabId`；handoff 文档声明来源标签页。agent 从那里读到 tabId 并
  显式传入 `--tab`。
- 不广播，连 opt-in 也不提供：web picker 不是 agent，无法为错误的页面给出聪明的回答。发布
  提交标记为 breaking；没有向后兼容垫片——唯一的用户会一起升级全部。

已考虑并否决：为 CLI 兼容性保留 latest-tab 兜底（用含糊的事实掩盖一个错误的事实）；一个显式的
`--broadcast` 调试 flag（盲目扇出没有正当受众）。

后果：对已关闭页面的 page-tool 调用会大声失败，错误里带该页面的 title/url；agent 会停下来问
人（HITL），而不是重试。
