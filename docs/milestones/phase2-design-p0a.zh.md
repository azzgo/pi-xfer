> 中文版 · 英文原文：[phase2-design-p0a.md](phase2-design-p0a.md)

# Milestone 2 design — P0-A Web Picker 站点兼容性

## 根因(2026-10-13 经 chrome-devtools 在真实站点上验证)

### npmjs.com — CSP `connect-src` 拦截 broker WebSocket

- 响应头:`connect-src 'self' …` 白名单;不允许 `ws://127.0.0.1:*`。
- 实测行为:`new WebSocket()` **构造时不抛错**(readyState 3),
  随后 `onerror` 触发,而 **`onclose` 永远不触发**。这打破了 broker-conn.js 的
  假设——close 总是跟在 error 之后(「onerror 后的必然 close」)。
- 用户为什么看不到任何提示:静默自动重连路径上 `conn.unreachable` toast 被抑制;
  唯一持续的信号是 fab 上的状态圆点。

### youtube.com — Trusted Types 强制导致初始化失败

- YouTube 下发 `require-trusted-types-for 'script'`。
- `el.innerHTML = …` **抛错**(`This document requires 'TrustedHTML' assignment`)。
- `main.js` 顶层调用 `buildUI()` → `shadow.js:29 root.innerHTML = …` 抛错,整个
  userscript 在任何接线之前就挂掉 —— 没有 fab、没有 UI、没有任何错误出口。
- WebSocket 在 YouTube 上正常(构造成功)—— 那里不是 CSP 的问题。

## 计划

### 修复 1 — Trusted Types 兼容层(web-picker.src)

- 新增一个很小的模块(例如 `web-picker.src/tt.js`):若 `window.trustedTypes` 存在,尝试
  `trustedTypes.createPolicy('pi-xfer', { createHTML: s => s })`(加保护 —— 该名字可能已
  被占用);导出 `setHTML(el, html)`,在强制生效时使用 policy 的 `createHTML`,
  否则回退为普通赋值。
- 把 `web-picker.src/ui/*.js` 和 `shadow.js` 中所有裸 `innerHTML` 赋值
  (约 10 处:shadow、combo、panel、pick,另用 grep 核对)替换为 `setHTML`。
- `main.js` 的初始化包一层,使失败时仍能浮出 toast/fab 错误态,而不是
  静默死掉。
- 注意:配合 `@grant` 指令,Tampermonkey 在不同浏览器上的沙箱可能不同;兼容层保持
  防御性(特性检测,绝不假设)。

### 修复 2 — CSP 拦截反馈(web-picker.src/broker-conn.js)

- 在 WS 连接挂起期间,监听 `document` 上的 `securitypolicyviolation`(capture);
  若 `violatedDirective === 'connect-src'` 且 `blockedURL` 匹配 broker 的 ws
  URL,则把该次连接视为被策略拦截。
- 被策略拦截的连接:停止退避重连(在这个页面上重试不可能成功),
  显示一个专门的 toast(新增 i18n key,en+zh:"site policy blocked the local broker
  connection"),并把 fab 置为明确的 "blocked" 状态,让静默的自动连接失败
  可见。
- 修正 close 假设:连接尝试也由 `onerror` 收尾(不只在
  `onclose`),因为被 CSP 拦截的 socket 永不 close。
### 修复 3 — 离线降级:无 broker 链接时复制 prompt(ui/send.js + 新的本地 composer)

- 规则:只要链路不是 `on` —— CSP 被拦截、broker 未运行、或用户根本从未
  连接 —— 发送流程就降级为 **copy-prompt**,而不是拒绝。
- 当前 `copyHandoffPrompt()` 在 state ≠ on 时以 `send.connectFirst` 直接退出,且
  prompt 文本由 broker 侧渲染(`KIND_COMPOSE`)。降级路径:
  - 在 picker 里**本地**组装,数据来自 GM storage 中已有的内容(picks 携带完整的
    `payloadFor()` schema;record 事件同理)—— 不往返 broker;
  - 跳过 targets 拉取;目标选择回退到上次使用的 `GM_TARGET` 或直接
    省略(反正接收方会手动打开 handoff 文件);
  - 使用**离线 prompt 模板**,不提及反向页面工具通道
    (那条链路已死)—— picks/records 在复制出的文本里是自包含的。
- 主发送(`doSend`)仍然要求有链路(它必须投递给 agent);只有
  copy-prompt 流程会降级。
- **UI 降级(用户决定 2026-10-13):当链路不是 `on` 时,完全隐藏发送
  按钮** —— 不是灰掉的禁用按钮,而是不显示。`renderConnPill`
  本来就在每次状态变化时重渲染,所以把切换挂在那里:
  - `on` → 发送分体按钮(发送 → + ▾)与今天一致;copy-prompt 仍在
    下拉菜单里;
  - `connecting` → 保持发送按钮可见(短暂态,避免每次重连都闪烁)但禁用;
  - `off` / `blocked` → 发送按钮隐藏;**copy-prompt 升为主按钮**
    (即上面的本地降级 composer)。连接 pill/标签本身已经解释了原因。
- blocked 状态(修复 2)成为第三种视觉状态,这样被 CSP 拦截的页面
  与「broker 只是没在运行」读起来不同。

### 文档

- `docs/guides/` 已知限制说明:带 `connect-src` CSP 且不允许 localhost 的
  站点无法连接(picker 显示 blocked 徽标,copy-prompt 仍可离线工作);
  Trusted Types 站点在修复 1 之后可正常工作。

## 涉及范围

`web-picker.src/tt.js`(新增)、`ui/shadow.js`、`ui/combo.js`、`ui/panel.js`、`ui/pick.js`、
`ui/send.js`、离线 prompt composer(新增)、`broker-conn.js`、`i18n.js`、`main.js`;
重新构建 `web-picker.user.js`;`docs/guides/` 说明。

## 风险

- Tampermonkey 的 world 各不相同(MV3 isolated world 与 page world);TT policy 必须在
  实际运行 UI 代码的那个 world 里创建 —— 要在 YouTube 上用真实 Tampermonkey 验证。
- `securitypolicyviolation` 也可能因无关的页面违规而触发 —— 把处理范围限定在
  待连接窗口和匹配的 blocked URL 上。
- userscript 验证是手动的(按 AGENTS.md,不在 verify-skill 范围内)。
