> 中文版 · 英文原文：[0007-web-picker-record-not-replay.md](0007-web-picker-record-not-replay.md)

# Web picker 采集的是人操作的 record，而非 agent 的重放

状态：accepted

## 背景

web-picker 循环交给 agent 的是静态的 Pick 标记；但有些 bug 只有在一段短操作序列的
动态前后行为中才会显形。我们考虑过让 agent 自己重放操作——例如重放一份 Chrome
DevTools Recorder 导出（Puppeteer 脚本或翻译后的 `page-tool` 调用）——最终决定不采用
任何重放路径。

重放跑在错误的环境里：agent 驱动的 Puppeteer 浏览器不是用户活着的那个标签页，因此会
丢失 web-picker 连接、登录态和所有可观测性钩子，而且它找到的每个"嫌疑点"仍然要在真实
标签页里重新复现。即使是在活标签页上重放 `page-tool` 步骤，也只是重新推导人已经产生过
的证据，还继承了 Recorder 自身的产物（强制刷新页面、选择器漂移）。让人亲手复现问题，
才是可得的最高保真度执行者。

## 决策

picker 增加一个 **Record 模式**：用户标记开始、自由操作页面、标记结束；picker 采集核心
动作的时间线（点击、字段级输入、SPA 路由变化、提交），加上从既有 console/network 环形
缓冲区切片出的场景数据，并把整段作为一个标记序列提交。不存在重放步骤——人的操作本身
就是证据。细节见 `pi/agent/extensions/xfer/docs/web-picker.md` 的"Planned: Record mode"
一节。

## 后果

- 录制 SSE/长轮询流量要求 `netRing` 记录 *pending* 中的请求（今天它只记录已完成的），
  这样 agent 才能通过 `network.log` 反查实时流。
- `annotation.submit` 上的 `record` 字段是纯增量的——没有新的帧类型，broker 不变。
- 跨源跳转会有意打断一次 Record（sessionStorage 是按源隔离的）；跨源复现不在范围内，
  直到出现真实需求。
