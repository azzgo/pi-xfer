// Freeze UI + hotkeys + press isolation.
// Radix 等模态弹窗的 FocusScope / DismissableLayer 兼容逻辑（focusin /
// pointerdown 拦截 + composed:false 克隆补发）也在这里。

import { HOTKEY, HOTKEY_REC } from '../constants.js';

export function initHotkeys(ctx) {
  const { root, els, toast } = ctx;
  const { elTxt, elSettings } = els;

  function updateFreezeUI() {
    const fz = root.getElementById('fz');
    if (!fz) return;
    fz.classList.toggle('on', ctx.pickState.frozen);
    fz.title = ctx.pickState.frozen ? '冻结：页面交互已屏蔽，浮层不会因点击/hover 关闭（点击此提示可切换）' : '实时：hover 可触发页面（展开子菜单等）（点击此提示可切换）';
  }
  ctx.updateFreezeUI = updateFreezeUI;

  function toggleFreeze() {
    ctx.pickState.frozen = !ctx.pickState.frozen;
    updateFreezeUI();
    toast(ctx.pickState.frozen ? '冻结：页面交互已屏蔽' : '实时：hover 可触发页面');
  }
  ctx.toggleFreeze = toggleFreeze;

  window.addEventListener('keydown', (e) => {
    const isHot = e.code === HOTKEY.code && e.altKey === HOTKEY.alt && e.shiftKey === HOTKEY.shift && !e.ctrlKey && !e.metaKey;
    const isRecHot = e.code === HOTKEY_REC.code && e.altKey === HOTKEY_REC.alt && e.shiftKey === HOTKEY_REC.shift && !e.ctrlKey && !e.metaKey;
    const isList = e.code === 'KeyL' && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
    if (isRecHot) { e.preventDefault(); e.stopPropagation(); ctx.toggleRecord(); return; }
    if (isList) { e.preventDefault(); e.stopPropagation(); ctx.togglePanel(); return; }
    if (isHot) {
      e.preventDefault(); e.stopPropagation();
      if (ctx.pickState.pickMode) { if (ctx.pickState.pinned) ctx.unpin(); else ctx.setActive(false); }
      else ctx.setActive(true);
      return;
    }
    if (ctx.pickState.pickMode && !ctx.pickState.pinned && e.code === 'KeyF' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault(); e.stopPropagation();
      toggleFreeze();
    }
  }, true);

  // 挂 document capture（保持 v1.10 原样：卡片未出现时键盘行为与旧版一致）
  document.addEventListener('keydown', (e) => {
    const ps = ctx.pickState;
    // Esc 收起「更多」下拉（在 target 下拉/面板之前处理）
    if (ctx.sendMenuOpen() && e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault(); e.stopPropagation(); ctx.closeSendMenu(); return;
    }
    // Esc 优先收起 target 下拉（capture 阶段拦截，避免顺带把整个面板也关了）
    if (ctx.comboOpen() && e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault(); e.stopPropagation(); ctx.closeDrop(); return;
    }
    if (ctx.getPanelOpen() && e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault(); ctx.closePanel(); return;
    }
    if (!ps.pickMode) return;
    if (ps.groupCard) {
      if (e.isComposing || e.keyCode === 229) return;
      const firstTarget = (e.composedPath && e.composedPath()[0]) || e.target;
      if (e.key === 'Enter' && firstTarget === elTxt && !e.shiftKey) {
        e.preventDefault(); ctx.submitGroup();
      } else if (e.key === 'Escape') {
        ctx.closeGroupCard();
      }
      return;
    }
    if (ps.pinned) {
      if (e.isComposing || e.keyCode === 229) return;
      const firstTarget = (e.composedPath && e.composedPath()[0]) || e.target;
      if (e.key === 'Enter' && firstTarget === elTxt && !e.shiftKey) {
        e.preventDefault(); ctx.submit();
      } else if (e.key === 'Escape') {
        ctx.unpin();
      }
      return;
    }
    if (e.key === 'Backspace' && ps.groupCount && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault(); e.stopPropagation();
      ctx.clearPendingGroup();                 // ⌫：清空待处理组合（工具栏 chip 同款）
      return;
    }
    if (e.key === 'Enter' && e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault(); e.stopPropagation();
      ctx.toggleGroup(ps.currentEl());         // ⇧Enter：当前高亮元素加入/移出组合
      return;
    }
    switch (e.key) {
      case ']': case 'ArrowDown': e.preventDefault(); ctx.shiftLayer(1); break;
      case '[': case 'ArrowUp': e.preventDefault(); ctx.shiftLayer(-1); break;
      case 'Enter': case ' ':
        e.preventDefault();
        if (ps.groupCount) ctx.openGroupCard(); else ctx.pin();   // 有待处理组合时 Enter = 组备注
        break;
      case 'Escape': e.preventDefault(); ctx.setActive(false); break;
      default:
        if (/^[1-9]$/.test(e.key)) { e.preventDefault(); ps.idx = Math.min(ps.stack.length - 1, +e.key - 1); ctx.refresh(); }
    }
  }, true);

  // Radix 等模态弹窗的 FocusScope 会在 document 上监听 focusin（capture），发现焦点
  // 落到弹窗容器之外就把焦点拉回去——host 挂在 documentElement 下，天然在 trap 外，
  // 备注卡片/面板的输入框一聚焦就被抢走。window capture 先于 document 上的页面监听
  // 执行，这里把指向自家 shadow root 的 focusin 拦下，弹窗就看不见这次聚焦。
  // stopPropagation 在 window capture 会连「向 shadow 内部 descent」一起掐掉，
  // 自家监听（如 target 输入框的 focus → 展开下拉）就收不到了——往真实目标
  // 补发一个 composed:false 克隆，事件只在 shadow 内传播，页面侧仍然不可见。
  // 仅在自家浮层（卡片/面板/设置）出现时启用新式拦截——按约定，浮层不在时
  // 键盘/鼠标行为与 v1.10 完全一致。
  function overlayActive() {
    return ctx.pickState.pinned != null || ctx.pickState.groupCard || ctx.getPanelOpen() || elSettings.style.display === 'block';
  }
  window.addEventListener('focusin', (e) => {
    if (!overlayActive()) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.indexOf(root) < 0) return;
    e.stopPropagation();
    const t = path[0];
    if (!t || !t.dispatchEvent) return;
    try {
      t.dispatchEvent(new FocusEvent('focusin', {
        bubbles: true, composed: false, cancelable: false,
      }));
    } catch (err) { /* shadow 内监听收不到这次的克隆，主流程不受影响 */ }
  }, true);

  // Radix DismissableLayer 一类「点外面即关闭」的层在 document 上监听
  // pointerdown/mousedown（capture）。shadow 里发出的事件离开 shadow 边界时
  // target 被重定向成 host，永远不在它的层内 → 点备注卡片就被当成「点击弹窗
  // 外部」，页面弹窗当场关闭并把焦点还给自己的 dismiss 按钮，看起来像点击
  // 穿透了浮层。这里在 window capture 末端把指向自家 UI 的按下事件拦下并
  // 阻止传播，再在真实目标上补发一个 composed:false 的克隆：事件只在 shadow
  // 内部传播（自家处理器照常工作），页面侧完全不可见。
  function isolatePress(e) {
    if (!overlayActive()) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.indexOf(root) < 0) return;
    e.stopPropagation();
    const t = path[0];
    if (!t || !t.dispatchEvent) return;
    const base = {
      bubbles: true, composed: false, cancelable: true,
      clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
      button: e.button, buttons: e.buttons, detail: e.detail,
    };
    try {
      t.dispatchEvent(new PointerEvent(e.type, Object.assign(base, {
        pointerId: e.pointerId, pointerType: e.pointerType,
        isPrimary: e.isPrimary, pressure: e.pressure,
      })));
    } catch (err) {
      try { t.dispatchEvent(new MouseEvent(e.type, base)); } catch (err2) { /* keep the press local-only */ }
    }
  }
  ['pointerdown', 'mousedown'].forEach((t) => window.addEventListener(t, isolatePress, true));
}
