// i18n — flat { key: { en, zh } } table + t(). Language is detected once per
// load: GM-persisted override first, then navigator.language (zh* → zh).
// The userscript UI is built once at injection, so switching language in the
// menu persists the choice and asks for a reload to apply it.

import { gm } from './storage.js';

export const GM_LANG = 'pi.wp.lang';

const STRINGS = {
  'menu.connect': { en: 'Connect broker', zh: '连接 broker' },
  'menu.disconnect': { en: 'Disconnect broker', zh: '断开 broker' },
  'menu.settings': { en: 'Connection settings…', zh: '连接设置…' },
  'menu.revokeAuto': { en: 'Revoke auto-connect for this page', zh: '撤销本页自动连接' },
  'menu.openPanel': { en: 'Open pick panel (⇧⌥L)', zh: '打开标注面板 (⇧⌥L)' },
  'menu.startPick': { en: 'Start picking (⇧⌥P)', zh: '开始拾取 (⇧⌥P)' },
  'menu.toggleRecord': { en: 'Start/stop recording (⇧⌥R)', zh: '开始/停止录制 (⇧⌥R)' },
  'menu.reinject': { en: 'Re-inject trigger', zh: '重新注入 trigger' },
  'menu.lang': { en: 'Language → 中文', zh: '语言 → English' },
  'menu.fabSize': { en: 'Fab size → large', zh: '悬浮按钮 → 大' },

  'toast.autoRevoked': { en: 'Auto-connect revoked for {origin}', zh: '已撤销 {origin} 的自动连接授权' },
  'toast.reinjected': { en: 'Trigger re-injected', zh: 'trigger 已重新注入' },
  'toast.reinjectStuck': { en: 'Trigger still on the page', zh: 'trigger 仍在页面上' },
  'toast.langSwitched': { en: 'Language set to English — reload the page to apply', zh: '语言已设为中文 — 刷新页面生效' },
  'toast.fabSize': { en: 'Fab size: {size}', zh: '悬浮按钮大小：{size}' },

  'bar.cycle': { en: 'cycle layer', zh: '切层' },
  'bar.jump': { en: 'jump', zh: '跳层' },
  'bar.select': { en: 'select', zh: '选中' },
  'bar.group': { en: 'add/remove group', zh: '加组/移出' },
  'bar.clearGroup': { en: 'clear group', zh: '清空组合' },
  'gclear.title': { en: 'Clear pending group (or press ⌫)', zh: '清空待处理组合（也可按 ⌫）' },
  'bar.freeze': { en: 'freeze', zh: '冻结' },
  'escx.title': { en: 'Exit pick mode', zh: '退出拾取模式' },
  'bar.exit': { en: 'exit', zh: '退出' },
  'fab.title': { en: 'pi xfer — pick, record, hand off', zh: 'pi xfer — 拾取、录制、交接' },
  'fab.hint': { en: 'Click to start picking · hover for panel / record', zh: '点击开始拾取 · 悬停展开面板 / 录制' },
  'fabrow.panel': { en: 'Picks', zh: '标注面板' },
  'fabrow.panel.title': { en: 'Open the pick panel (⇧⌥L)', zh: '打开标注面板（⇧⌥L）' },
  'fabrow.record': { en: 'Record', zh: '录制操作' },
  'fabrow.record.title': { en: 'Start/stop recording (⇧⌥R)', zh: '开始/停止录制（⇧⌥R）' },
  'cnt.title': { en: 'Picked elements / record', zh: '已选元素 / 录制' },
  'panel.pick': { en: '⌖ Pick', zh: '⌖ 拾取' },
  'panel.pick.title': { en: 'Start picking elements (⇧⌥P)', zh: '开始拾取元素（⇧⌥P）' },
  'panel.record': { en: '● Record', zh: '● 录制' },
  'panel.record.title': { en: 'Start/stop recording (⇧⌥R)', zh: '开始/停止录制（⇧⌥R）' },
  'recbadge': { en: 'panel', zh: '面板' },
  'recstop': { en: '■ Stop', zh: '■ 停止' },
  'recdiscard': { en: 'Discard', zh: '丢弃' },

  'card.placeholder': { en: 'Note (optional, Enter to submit)', zh: '备注（可选，留空直接回车提交）' },
  'card.cancel': { en: 'Cancel Esc', zh: '取消 Esc' },
  'card.ok': { en: '✓ OK Enter', zh: '✓ 确认 Enter' },
  'card.groupPlaceholder': { en: 'Group note (optional, shared by the whole group)', zh: '组备注（可选，整组共用这一条）' },
  'card.groupOk': { en: '✓ Submit {n} Enter', zh: '✓ 提交 {n} 项 Enter' },

  'panel.title': { en: 'Picks', zh: '已选备注' },
  'panel.empty': { en: 'No elements picked yet', zh: '还没有选中任何元素' },
  'panel.pclose.title': { en: 'Close Esc', zh: '关闭 Esc' },
  'count.items': { en: '{n}', zh: '{n} 条' },
  'group.label': { en: '⧉ group {g}', zh: '⧉ 组 {g}' },
  'note.placeholder': { en: 'Note… (auto-saves on blur)', zh: '备注…（失焦自动保存）' },
  'btn.delete': { en: 'Delete', zh: '删除' },

  'pick.added': { en: 'Picked {sel}', zh: '已选中 {sel}' },
  'pick.deleted': { en: 'Deleted {sel}', zh: '已删除 {sel}' },
  'pick.cleared': { en: 'Cleared {n} picks', zh: '已清空 {n} 条标注' },
  'pick.layers': { en: '{n}', zh: '{n}层' },
  'group.added': { en: 'Added to group ({n} total)', zh: '已加入组合（共 {n} 项）' },
  'group.removed': { en: 'Removed from group ({n} left)', zh: '已移出组合（剩 {n} 项）' },
  'group.cleared': { en: 'Pending group cleared ({n} items)', zh: '已清空待处理组合（{n} 项）' },
  'group.tagTitle': { en: 'Click to remove from group', zh: '点击移出组合' },
  'group.selected': { en: 'Picked {n} · group {gid}', zh: '已选中 {n} 项 · 组 {gid}' },
  'gh.note': { en: ' · <kbd>Enter</kbd>group note ({n})', zh: ' · <kbd>Enter</kbd>组备注({n})' },

  'note.saved': { en: 'Note saved', zh: '备注已保存' },
  'note.synced': { en: ' (synced to {n} in group)', zh: '（已同步组内 {n} 项）' },
  'record.deleted': { en: 'Record deleted', zh: '已删除操作记录' },
  'record.summary': { en: '⏺ Record {id} · {n} events', zh: '⏺ 记录 {id} · {n} 事件' },
  'record.started': { en: 'Recording started · interact with the page, ⇧⌥R to stop', zh: '录制开始 · 操作页面，⇧⌥R 停止' },
  'record.discarded': { en: 'Recording discarded', zh: '录制已丢弃' },
  'record.done': { en: 'Recording done · {n} events · open the panel to send', zh: '录制完成 · {n} 事件 · 打开面板发送' },

  'send.label': { en: 'Send to agent (⌘/Ctrl+Enter to send · prompt optional)', zh: '发送到 agent（⌘/Ctrl+Enter 发送 · prompt 可留空）' },
  'prompt.placeholder': { en: 'What should the agent do? Leave empty = respond to each pick\u2019s note / explain the element\u2019s rendering', zh: '要让 agent 做什么？留空 = 回应各标注的 note / 解释元素渲染逻辑' },
  'target.label': { en: 'Target', zh: '目标' },
  'tinput.placeholder': { en: 'broker not connected', zh: '未连接 broker' },
  'trefresh.title': { en: 'Refresh target list', zh: '刷新 target 列表' },
  'conn.off': { en: 'Not connected · click to connect', zh: '未连接 · 点击连接' },
  'conn.on': { en: 'broker connected', zh: 'broker 已连接' },
  'conn.connecting': { en: 'Connecting…', zh: '连接中…' },
  'conn.blocked': { en: 'Blocked by site policy', zh: '被站点策略拦截' },
  'pill.disconnect.title': { en: 'Click to disconnect broker', zh: '点击断开 broker' },
  'pill.off.title': { en: 'Click to connect broker (opens settings on failure)', zh: '点击连接 broker（失败会打开连接设置）' },
  'pill.blocked.title': { en: "This site's Content Security Policy blocks the local broker (connect-src) — retrying cannot succeed here; copy the handoff prompt instead", zh: '本站 CSP（connect-src）拦截了本地 broker — 重试也不会成功；请改用复制 handoff prompt' },
  'clearbtn': { en: 'Clear', zh: '清空' },
  'sendbtn': { en: 'Send →', zh: '发送 →' },
  'sendmore.title': { en: 'More actions', zh: '更多操作' },
  'copyprompt': { en: '⧉ Copy handoff prompt', zh: '⧉ 复制 handoff prompt' },
  'copyprompt.sub': { en: 'broker composes the full handoff doc → clipboard (send to any agent with bash)', zh: 'broker 拼好完整 handoff 文档 → 剪贴板（发给任意有 bash 的 agent）' },

  'bag.stageMenu': { en: '↑ Stage to broker', zh: '↑ 暂存到 broker' },
  'bag.stageMenu.sub': { en: 'move this page\'s picks into the cross-page staging bag (clears this page)', zh: '把本页的标注移入跨页暂存袋（本页清空）' },
  'bag.entry': { en: 'Bag', zh: '暂存袋' },
  'bag.entry.title': { en: 'Cross-page staging bag (requires broker connection)', zh: '跨页暂存袋（需要连接 broker）' },
  'bag.title': { en: 'Staging bag', zh: '暂存袋' },
  'bag.countTruncated': { en: '{n} of {total} markers (sending covers all)', zh: '显示 {n} / 共 {total} 条（发送覆盖全部）' },
  'bag.count': { en: '{pages} pages · {n} markers', zh: '{pages} 页 · {n} 条' },
  'bag.empty': { en: 'Bag is empty — on any connected page use ▾ → Stage to broker', zh: '暂存袋是空的 — 在已连接的页面用 ▾ → 暂存到 broker' },
  'bag.sendLabel': { en: 'Send whole bag (multi-page provenance in one handoff)', zh: '整袋发送（多页 provenance 合成一只 handoff）' },
  'bag.promptPlaceholder': { en: 'Note for the agent about this bag…', zh: '关于这批标注的说明…' },
  'bag.targetLabel': { en: 'Target', zh: '发送目标' },
  'bag.send': { en: 'Send bag', zh: '发送整袋' },
  'bag.delivered': { en: 'Bag delivered (handoff {id}) — bag cleared', zh: '整袋已送达（handoff {id}）— 已清空' },
  'bag.emptyCannotSend': { en: 'Bag is empty', zh: '暂存袋是空的' },
  'bag.copyHint': { en: 'The bag lives on the broker — send it with Send bag; Copy prompt only covers this tab\'s picks', zh: '袋在 broker 上 — 用「发送整袋」；复制 prompt 只覆盖本页的标注' },
  'bag.noteReadonly': { en: 'Bag entries are broker-owned — notes are fixed at staging time', zh: '袋条目由 broker 持有 — 备注以暂存时刻为准' },
  'bag.staged': { en: 'Staged to broker ({n} in bag)', zh: '已暂存到 broker（袋内 {n} 条）' },
  'bag.stageFailed': { en: 'Stage failed: {detail}', zh: '暂存失败: {detail}' },
  'bag.unstaged': { en: 'Removed from the bag', zh: '已从暂存袋删除' },
  'bag.unstageFailed': { en: 'Delete failed: {detail}', zh: '删除失败: {detail}' },
  // degraded-state button: deliberately short — the status line already says what
  // gets copied, and the full label overflowed the panel next to a long status.
  'copyprompt.offline': { en: '⧉ Copy', zh: '⧉ 复制' },

  'settings.title': { en: 'Connection settings', zh: '连接设置' },
  'settings.burl': { en: 'BROKER URL (WS)', zh: 'BROKER 地址（WS）' },
  'settings.sprops': { en: 'framework.inspect includes component props/state (default off)', zh: 'framework.inspect 附带组件 props/state（默认关）' },
  'settings.sauto': { en: 'Auto-connect broker on this domain (authorized after one manual connect; silently reconnects on reload)', zh: '本域名自动连接 broker（手动连上过一次即授权，页面刷新后静默重连）' },
  'settings.swrite': { en: 'Allow agent to operate this page (dom.click / dom.setValue, default off)', zh: '允许 agent 操作本页（dom.click / dom.setValue，默认关）' },
  'settings.cancel': { en: 'Cancel', zh: '取消' },
  'settings.save': { en: 'Save & connect', zh: '保存并连接' },
  'settings.toast.on': { en: 'on', zh: '已开启' },
  'settings.toast.off': { en: 'off', zh: '已关闭' },
  'settings.toast.revoked': { en: 'revoked', zh: '已撤销' },
  'settings.toast.fprops': { en: 'framework.inspect props/state {state}', zh: 'framework.inspect props/state {state}' },
  'settings.toast.autoLink': { en: 'Auto-connect on this page {state}', zh: '本页自动连接 {state}' },
  'settings.toast.write': { en: 'Agent page-write permission {state}', zh: 'agent 页面操作权限 {state}' },
  'settings.toast.saved': { en: 'Saved, connecting…', zh: '已保存，连接中…' },

  'fz.on.title': { en: 'Frozen: page interaction blocked, overlays won\u2019t close on click/hover (click to toggle)', zh: '冻结：页面交互已屏蔽，浮层不会因点击/hover 关闭（点击此提示可切换）' },
  'fz.off.title': { en: 'Live: hover can trigger the page (open submenus etc.) (click to toggle)', zh: '实时：hover 可触发页面（展开子菜单等）（点击此提示可切换）' },
  'fz.on': { en: 'Frozen: page interaction blocked', zh: '冻结：页面交互已屏蔽' },
  'fz.off': { en: 'Live: hover can trigger the page', zh: '实时：hover 可触发页面' },

  'combo.noSessions': { en: '(no active local sessions)', zh: '（无活跃 local session）' },
  'combo.none': { en: 'no active local sessions', zh: '无活跃 local session' },
  'combo.noMatch': { en: 'No matching target', zh: '无匹配目标' },
  'combo.hint': { en: 'Type to filter · ↑↓ select · Enter confirm · Esc close', zh: '输入过滤 · ↑↓ 选择 · Enter 确认 · Esc 关闭' },
  'combo.switched': { en: 'Target switched: {name}', zh: '目标已切换：{name}' },
  'combo.refreshed': { en: 'Target list refreshed ({n})', zh: '目标列表已刷新（{n}）' },
  'combo.noneFound': { en: 'No active local sessions found', zh: '没有发现活跃 local session' },

  'send.needContent': { en: 'Pick elements, record actions, or write a prompt first', zh: '先标注元素、录制操作、或写 prompt' },
  'send.composing': { en: 'Requesting full handoff prompt from broker…', zh: '正在向 broker 请求完整 handoff prompt…' },
  'send.composeFailed': { en: 'Failed to compose prompt: {detail}', zh: '拼 prompt 失败: {detail}' },
  'send.clipboard': { en: 'Clipboard unavailable (needs GM_setClipboard or https/localhost)', zh: '剪贴板不可用（需 GM_setClipboard 或 https/localhost）' },
  'send.copied': { en: 'Handoff prompt copied ({n} chars · paste to any agent)', zh: 'handoff prompt 已复制（{n} 字符 · 可粘贴给任意 agent）' },
  'send.copiedOffline': { en: 'Handoff prompt composed in this tab and copied ({n} chars · no broker link, so no follow-up channel)', zh: '已在本页内拼好 handoff prompt 并复制（{n} 字符 · 未连 broker，无回查通道）' },
  'send.noTarget': { en: 'No target available: run xfer listen in a pi session first', zh: '没有可用目标：先启动 pi session 的 xfer listen' },
  'send.noTargetOffline': { en: 'No broker link — copy the handoff prompt instead (send button needs a connected broker)', zh: '未连接 broker — 请改用复制 handoff prompt（发送按钮需要已连接的 broker）' },
  'send.promptOnly.confirm': { en: 'No elements picked — send prompt only?', zh: '没有标注任何元素，只发 prompt？' },
  'send.sending': { en: 'Sending…', zh: '发送中…' },
  'send.delivered': { en: 'Delivered to agent (handoff {id}) · tab {tab}', zh: '已送达 agent（handoff {id}）· tab {tab}' },
  'send.tabCopied': { en: 'tabId {tab} copied', zh: '已复制 tabId {tab}' },
  'send.failed': { en: 'Send failed: {detail}', zh: '发送失败: {detail}' },
  'send.connecting': { en: 'Connecting {url} …', zh: '正在连接 {url} …' },

  'conn.wsFailed': { en: 'WebSocket creation failed: {msg}', zh: 'WS 创建失败: {msg}' },
  'toast.policyBlocked': { en: "Site policy (CSP connect-src) blocked the local broker connection — retrying cannot succeed on this page; the handoff prompt can still be copied offline", zh: '站点策略（CSP connect-src）拦截了本地 broker 连接 — 本页重试也不会成功；仍可在离线模式复制 handoff prompt' },
  'conn.brokerError': { en: 'broker error: {code}', zh: 'broker 错误: {code}' },
  'conn.closed': { en: 'broker connection closed', zh: 'broker 连接已断开' },
  'conn.unreachable': { en: 'Cannot reach broker: {url} (edit the address in connection settings)', zh: 'broker 连不上: {url}（连接设置里可改地址）' },
  'conn.disconnected': { en: 'Disconnected', zh: '已断开' },
  'conn.notConnected': { en: 'broker not connected', zh: 'broker 未连接' },
  'conn.noResponse': { en: 'broker no response', zh: 'broker 无响应' },
};

let lang = (function detect() {
  const saved = gm.get(GM_LANG, '');
  if (saved === 'en' || saved === 'zh') return saved;
  return (typeof navigator !== 'undefined' && navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
})();

export function currentLang() { return lang; }

export function toggleLang() {
  lang = lang === 'zh' ? 'en' : 'zh';
  gm.set(GM_LANG, lang);
  return lang;
}

export function t(key, vars) {
  const entry = STRINGS[key];
  if (!entry) { console.warn('[pi.wp.i18n] missing key:', key); return key; }
  let s = entry[lang] !== undefined ? entry[lang] : entry.en;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
  return s;
}
