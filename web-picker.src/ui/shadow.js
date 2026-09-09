// Shadow-DOM chrome — host injection, template, element refs, toast, fab pos.
// Pure DOM ownership: no protocol, no pick state. Everything else gets the
// built UI injected from main.js.

import { HOST_FLAG, KEY_POS } from '../constants.js';

export function buildUI() {
  const host = document.createElement('div');
  host.setAttribute(HOST_FLAG, '');
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none' });
  // document-start 注入时 documentElement 可能尚未挂出——先注入一次（能的话），
  // 否则等 DOMContentLoaded；MutationObserver 也等 documentElement 存在后再挂
  function injectHost() {
    if (host.isConnected || !document.documentElement) return;
    document.documentElement.appendChild(host);
  }
  injectHost();
  if (!host.isConnected) {
    document.addEventListener('DOMContentLoaded', injectHost, { once: true });
  } else {
    new MutationObserver(() => { if (!host.isConnected) injectHost(); })
      .observe(document.documentElement, { childList: true });
  }

  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host {
        --wp-font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
        --wp-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        --wp-ink: #0f172a;
        --wp-muted: #64748b;
        --wp-line: #e2e8f0;
        --wp-soft: #f8fafc;
        --wp-accent: #4f8cff;
        --wp-accent-deep: #3b76e8;
        --wp-green: #22c55e;
        --wp-amber: #f59e0b;
        --wp-dark: #0f1522;
        --wp-radius: 12px;
        --wp-shadow: 0 1px 2px rgba(15,23,42,.05), 0 16px 40px -12px rgba(15,23,42,.25);
      }
      * { box-sizing: border-box; }
      /* ---- pick-mode chrome ---- */
      #hl { position: fixed; margin: 0; padding: 0; border: 2px solid var(--wp-accent); background: rgba(79,140,255,.12);
        border-radius: 3px; pointer-events: none; transition: all .04s linear; display: none; }
      #hl.pin { border-color: #ff5a5a; background: rgba(255,90,90,.14); }
      /* ---- pending group marks (shift-group) ---- */
      #gwrap { position: fixed; inset: 0; pointer-events: none; display: none; }
      .gmark { position: fixed; margin: 0; border: 2px dashed var(--wp-amber);
        background: rgba(245,158,11,.10); border-radius: 3px; pointer-events: none; }
      .gmark .gi { position: absolute; top: -16px; left: -2px; background: var(--wp-amber);
        color: #fff; font: 700 10px/16px var(--wp-mono); padding: 0 5px;
        border-radius: 4px 4px 4px 0; white-space: nowrap; pointer-events: auto; cursor: pointer; }
      #badge { position: fixed; top: 0; left: 0; transform: translate(-50%, -150%);
        background: var(--wp-dark); color: #fff; font: 600 11px/1.4 var(--wp-font);
        padding: 4px 9px; border-radius: 6px; white-space: nowrap; pointer-events: none; display: none;
        box-shadow: 0 4px 12px rgba(15,23,42,.35); }
      #badge small { opacity: .6; font-weight: 400; }
      #info { position: fixed; top: 0; left: 0; transform: translate(0, 100%);
        background: rgba(15,21,34,.92); color: #e2e8f0; font: 11px/1.4 var(--wp-mono);
        padding: 5px 9px; border-radius: 6px; max-width: 80vw; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; pointer-events: none; display: none;
        box-shadow: 0 4px 12px rgba(15,23,42,.3); backdrop-filter: blur(6px); }
      #info .pv { color: #7dabff; } #info .dim { color: #94a3b8; }
      #bar { position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
        background: rgba(15,21,34,.96); color: #cbd5e1; font: 12px/1 var(--wp-font);
        padding: 9px 16px; border-radius: 999px; display: none; gap: 14px; align-items: center;
        box-shadow: 0 8px 24px rgba(15,23,42,.35); user-select: none; pointer-events: auto;
        cursor: move; backdrop-filter: blur(6px); }
      #bar b { color: #fff; letter-spacing: .08em; font-size: 11px; }
      #bar kbd { background: #1e293b; border: 1px solid #334155; border-bottom-width: 2px;
        border-radius: 4px; padding: 1px 5px; font: 10.5px var(--wp-mono); color: #e2e8f0; }
      #bar .muted { color: #94a3b8; display: inline-flex; gap: 3px; align-items: center; }
      /* 可点的提示块（清空组合 / 冻结 / 退出）给 pointer 反馈；其余纯提示保持 move */
      #bar #gclear, #bar #fz, #bar #escx { cursor: pointer; }
      #bar #gclear:hover, #bar #fz:hover, #bar #escx:hover { color: #fff; }
      #bar #fz.on kbd { background: #0c4a6e; border-color: #0369a1; color: #e0f2fe; }
      #bar #gh.on kbd { background: #451a03; border-color: #b45309; color: #fde68a; }
      /* ---- fab ---- */
      #fab { position: fixed; width: 46px; height: 46px; border-radius: 14px;
        border: 1px solid rgba(255,255,255,.12); background: linear-gradient(160deg, #1b2230, #12161f);
        color: #fff; padding: 0; outline: none; cursor: grab;
        box-shadow: 0 10px 26px rgba(10,14,25,.45), inset 0 1px 0 rgba(255,255,255,.09);
        user-select: none; pointer-events: auto; z-index: 2147483647; transition: transform .15s ease, box-shadow .15s ease; }
      #fab:hover { transform: translateY(-2px);
        box-shadow: 0 14px 30px rgba(10,14,25,.55), 0 0 0 3px rgba(79,140,255,.30), inset 0 1px 0 rgba(255,255,255,.1); }
      #fab:active { cursor: grabbing; transform: scale(.96); }
      #fab svg { width: 20px; height: 20px; position: absolute; inset: 50% auto auto 50%;
        transform: translate(-50%, -50%); transition: transform .2s ease; pointer-events: none; }
      #fab:hover svg { transform: translate(-50%, -50%) rotate(45deg) scale(1.08); }
      #cnt { position: absolute; bottom: -6px; right: -6px; min-width: 20px; height: 20px; border-radius: 10px;
        background: #ef4444; color: #fff; font: 700 11px/20px var(--wp-font); text-align: center; padding: 0 5px;
        display: none; box-shadow: 0 0 0 2px #161a21; cursor: pointer; }
      #dot { position: absolute; top: -4px; left: -4px; width: 12px; height: 12px; border-radius: 6px;
        background: #94a3b8; box-shadow: 0 0 0 2px #161a21; transition: background .2s; }
      #dot.connecting { background: var(--wp-amber); }
      #dot.on { background: var(--wp-green); box-shadow: 0 0 0 2px #161a21, 0 0 8px rgba(34,197,94,.8); }
      /* ---- floating cards ---- */
      #card, #panel, #settings {
        background: #fff; border: 1px solid var(--wp-line); border-radius: var(--wp-radius);
        box-shadow: var(--wp-shadow); color: var(--wp-ink);
        font: 13px/1.5 var(--wp-font); z-index: 2147483647; pointer-events: auto;
      }
      #card { position: fixed; width: 300px; padding: 14px; display: none; cursor: move; }
      #card .sel { font: 11px/1.5 var(--wp-mono); color: #475569; background: var(--wp-soft);
        border: 1px solid var(--wp-line); padding: 6px 8px; border-radius: 8px;
        word-break: break-all; white-space: pre-wrap; margin-bottom: 10px; max-height: 70px; overflow: auto; }
      #card .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
      /* ---- shared form controls ---- */
      textarea, input, select {
        width: 100%; border: 1px solid var(--wp-line); border-radius: 8px; padding: 7px 10px;
        font: 12.5px/1.5 var(--wp-font); background: #fff; color: var(--wp-ink);
        outline: none; transition: border-color .15s ease, box-shadow .15s ease;
      }
      textarea { resize: vertical; min-height: 44px; }
      textarea:focus, input:focus {
        border-color: var(--wp-accent); box-shadow: 0 0 0 3px rgba(79,140,255,.14);
      }
      input { font-family: var(--wp-mono); font-size: 12px; }
      input:disabled { background: var(--wp-soft); color: var(--wp-muted); cursor: not-allowed; }
      /* ---- target combobox（可搜索下拉，取代原生 <select>）---- */
      #tcombo { position: relative; flex: 1; min-width: 0; }
      #tdrop { position: absolute; left: 0; right: 0; bottom: calc(100% + 6px); z-index: 10;
        background: #fff; border: 1px solid var(--wp-line); border-radius: 10px;
        box-shadow: var(--wp-shadow); padding: 4px; max-height: 224px; overflow-y: auto; display: none; }
      #tdrop.open { display: block; }
      #tdrop::-webkit-scrollbar { width: 8px; }
      #tdrop::-webkit-scrollbar-thumb { background: #dde4ec; border-radius: 4px; }
      #tdrop .titem { padding: 6px 9px; border-radius: 7px; cursor: pointer; }
      #tdrop .titem.hl { background: #eaf1ff; }
      #tdrop .tname { font: 600 12px/1.45 var(--wp-mono); color: var(--wp-ink); word-break: break-all; }
      #tdrop .tname b, #tdrop .tsub b { color: var(--wp-accent-deep); }
      #tdrop .tsub { font: 10.5px/1.45 var(--wp-mono); color: var(--wp-muted);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #tdrop .tick { color: var(--wp-green); font-weight: 700; }
      #tdrop .tempty { padding: 12px 8px; text-align: center; color: #94a3b8; font-size: 12px; }
      #tdrop .thint { margin-top: 3px; padding: 5px 9px 2px; border-top: 1px solid var(--wp-line);
        color: #94a3b8; font-size: 10px; }
      button { font: 600 12px var(--wp-font); border: none; border-radius: 8px; cursor: pointer;
        padding: 7px 14px; transition: background .15s ease, box-shadow .15s ease, transform .05s ease; }
      button:active { transform: translateY(1px); }
      button.primary { background: var(--wp-accent); color: #fff; box-shadow: 0 1px 3px rgba(79,140,255,.45); }
      button.primary:hover { background: var(--wp-accent-deep); }
      button.primary:disabled { background: #c4d5f7; box-shadow: none; cursor: not-allowed; transform: none; }
      button.ghost { background: #f1f5f9; color: var(--wp-muted); }
      button.ghost:hover { background: #e2e8f0; color: #475569; }
      button.icon { padding: 7px 9px; font-size: 13px; line-height: 1; }
      button.icon:disabled { opacity: .45; cursor: not-allowed; transform: none; }
      /* ---- panel ---- */
      /* 不设 overflow:hidden —— sendbox 里的 target 下拉需要向上溢出面板显示 */
      #panel { position: fixed; top: 60px; right: 16px; width: 348px; max-height: 80vh;
        display: none; flex-direction: column; }
      #panel .ph { display: flex; align-items: center; gap: 8px; padding: 11px 14px;
        background: var(--wp-soft); border-bottom: 1px solid var(--wp-line); user-select: none;
        cursor: move; border-radius: var(--wp-radius) var(--wp-radius) 0 0; }
      #panel .ph b { flex: 1; font-size: 13px; font-weight: 600; }
      #panel .ph .cnt2 { color: var(--wp-muted); font-size: 11px; }
      #panel .ph button { background: transparent; color: var(--wp-muted); padding: 3px 8px; border-radius: 6px; }
      #panel .ph button:hover { background: #e8edf3; color: #334155; }
      #plist { overflow-y: auto; padding: 10px; flex: 1; }
      #plist::-webkit-scrollbar { width: 8px; }
      #plist::-webkit-scrollbar-thumb { background: #dde4ec; border-radius: 4px; }
      #plist::-webkit-scrollbar-thumb:hover { background: #cbd5e1; }
      #plist .empty { color: #94a3b8; text-align: center; padding: 28px 0; font-size: 12px; }
      #plist .item { border: 1px solid var(--wp-line); border-radius: 10px; padding: 9px; margin-bottom: 8px;
        background: #fff; transition: border-color .15s ease, box-shadow .15s ease; }
      #plist .item:hover { border-color: #c9d6ea; box-shadow: 0 2px 8px rgba(15,23,42,.06); }
      #plist .item .psel { font: 11px/1.5 var(--wp-mono); color: #475569; background: var(--wp-soft);
        border: 1px solid var(--wp-line); padding: 4px 7px; border-radius: 6px;
        word-break: break-all; max-height: 44px; overflow: auto; }
      #plist .item .psrc { color: #059669; font: 10px/1.5 var(--wp-mono); margin-top: 4px; word-break: break-all; }
      #plist .item .pgroup { display: inline-block; margin-top: 4px; padding: 1px 7px;
        background: #fffbeb; border: 1px solid #fde68a; border-radius: 999px;
        color: #b45309; font: 600 10px/1.6 var(--wp-mono); }
      #plist .item .pprev { color: #94a3b8; font-size: 11px; margin: 4px 0; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; }
      #plist .item textarea { min-height: 34px; font-size: 12px; padding: 5px 8px; }
      #plist .item .prow { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; }
      #plist .item .pts { color: #94a3b8; font-size: 10px; font-family: var(--wp-mono); }
      #plist .item .del { background: none; color: #ef4444; font-size: 11px; padding: 2px 8px; border-radius: 6px; }
      #plist .item .del:hover { background: #fef2f2; }
      /* ---- send box ---- */
      #sendbox { border-top: 1px solid var(--wp-line); padding: 12px 14px; display: flex;
        flex-direction: column; gap: 7px; background: var(--wp-soft); border-radius: 0 0 var(--wp-radius) var(--wp-radius); }
      #sendbox .lbl { font-size: 11px; font-weight: 600; color: var(--wp-muted); letter-spacing: .02em; }
      #sendbox textarea { background: #fff; }
      #sendbox .trow { display: flex; gap: 6px; align-items: center; }
      #sendbox .srow { display: flex; gap: 8px; align-items: center; margin-top: 2px; }
      /* ---- split send button group（发送 + ▾ 更多下拉）---- */
      #sendgroup { position: relative; display: flex; flex: none; }
      #sendgroup #sendbtn { border-radius: 8px 0 0 8px; }
      #sendgroup #sendmore { border-radius: 0 8px 8px 0; padding: 7px 8px; font-size: 10px;
        border-left: 1px solid rgba(255,255,255,.30); }
      #sendmenu { position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 20;
        background: #fff; border: 1px solid var(--wp-line); border-radius: 10px;
        box-shadow: var(--wp-shadow); padding: 4px; min-width: 230px; display: none; }
      #sendmenu.open { display: block; }
      #sendmenu .mitem { padding: 7px 10px; border-radius: 7px; cursor: pointer;
        font: 600 12px/1.5 var(--wp-font); color: var(--wp-ink); }
      #sendmenu .mitem:hover { background: #eaf1ff; }
      #sendmenu .msub { font: 400 10px/1.5 var(--wp-font); color: var(--wp-muted); margin-top: 1px; }
      #connstate { display: flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 500;
        color: var(--wp-muted); flex: 1; cursor: pointer; user-select: none; white-space: nowrap; }
      #connstate .dot { flex: none; width: 9px; height: 9px; border-radius: 50%;
        background: #94a3b8; transition: background .2s ease, box-shadow .2s ease; }
      #connstate.connecting .dot { background: var(--wp-amber); }
      #connstate.on { color: #15803d; }
      #connstate.on .dot { background: var(--wp-green); box-shadow: 0 0 0 3px rgba(34,197,94,.18); }
      #connstate:hover { text-decoration: underline; text-underline-offset: 3px; }
      /* ---- settings modal ---- */
      #settings { position: fixed; width: 312px; padding: 16px; display: none; top: 20vh; right: 20px; }
      #settings b { font-size: 13px; display: block; margin-bottom: 2px; }
      #settings .lbl { font-size: 11px; font-weight: 600; color: var(--wp-muted); margin: 12px 0 4px;
        letter-spacing: .02em; }
      #settings .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
      #settings .chk { margin-top: 12px; font-size: 12px; color: var(--wp-muted); display: flex;
        gap: 7px; align-items: center; cursor: pointer; user-select: none; }
      #settings input[type="checkbox"] { width: auto; margin: 0; }
      /* ---- toast ---- */
      #toast { position: fixed; bottom: 84px; left: 50%; transform: translateX(-50%);
        background: rgba(15,21,34,.95); color: #f1f5f9; font: 12.5px var(--wp-font);
        padding: 9px 18px; border-radius: 999px; opacity: 0; transition: opacity .2s ease, transform .2s ease;
        transform: translateX(-50%) translateY(6px); pointer-events: none; max-width: 80vw; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; z-index: 2147483647;
        box-shadow: 0 8px 24px rgba(15,23,42,.35); backdrop-filter: blur(6px); }
      #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    </style>
    <div id="hl"></div>
    <div id="gwrap"></div>
    <div id="badge"></div>
    <div id="info"></div>
    <div id="bar"><b>PICK</b>
      <span class="muted"><kbd>[</kbd><kbd>]</kbd>切层</span>
      <span class="muted"><kbd>1</kbd>-<kbd>9</kbd>跳层</span>
      <span class="muted"><kbd>Enter</kbd>选中</span>
      <span class="muted" id="gh"><kbd>⇧Enter</kbd>加组/移出</span>
      <span class="muted" id="gclear" style="display:none" title="清空待处理组合（也可按 ⌫）"><kbd>⌫</kbd>清空组合</span>
      <span class="muted" id="fz"><kbd>F</kbd>冻结</span>
      <span class="muted" id="escx" title="退出拾取模式"><kbd>Esc</kbd>退出</span>
    </div>
    <div id="card">
      <div class="sel" id="sel"></div>
      <textarea id="txt" placeholder="备注（可选，留空直接回车提交）"></textarea>
      <div class="row">
        <button class="ghost" id="cancel">取消 Esc</button>
        <button class="primary" id="ok">✓ 确认 Enter</button>
      </div>
    </div>
    <div id="panel">
      <div class="ph" id="ph"><b>已选备注</b><span class="cnt2" id="pcount"></span><button id="pclose" title="关闭 Esc">✕</button></div>
      <div id="plist"></div>
      <div id="sendbox">
        <div class="lbl">发送到 agent（⌘/Ctrl+Enter 发送 · prompt 可留空）</div>
        <textarea id="prompt" placeholder="要让 agent 做什么？留空 = 回应各标注的 note / 解释元素渲染逻辑"></textarea>
        <div class="trow">
          <span class="lbl">目标</span>
          <div id="tcombo">
            <input id="tinput" placeholder="未连接 broker" autocomplete="off" spellcheck="false" />
            <div id="tdrop"></div>
          </div>
          <button class="ghost icon" id="trefresh" title="刷新 target 列表">⟳</button>
        </div>
        <div class="srow">
          <span id="connstate"><span class="dot"></span><span id="conntext">未连接 · 点击连接</span></span>
          <button class="ghost" id="clearbtn">清空</button>
          <div id="sendgroup">
            <button class="primary" id="sendbtn">发送 →</button>
            <button class="primary more" id="sendmore" title="更多操作">▾</button>
            <div id="sendmenu">
              <div class="mitem" id="copyprompt">⧉ 复制 handoff prompt<div class="msub">broker 拼好完整 handoff 文档 → 剪贴板（发给任意有 bash 的 agent）</div></div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <button id="fab" title="元素拾取 · 点击进入（或按 ⇧⌥P）· 点红色数字角标开备注面板 · 绿点=broker 已连接">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round">
        <circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>
      </svg>
      <span id="dot"></span>
      <span id="cnt">0</span>
    </button>
    <div id="toast"></div>
    <div id="settings">
      <b>连接设置</b>
      <div class="lbl">BROKER 地址（WS）</div>
      <input id="sburl" placeholder="ws://127.0.0.1:4719" />
      <label class="chk"><input type="checkbox" id="sprops" /> framework.inspect 附带组件 props/state（默认关）</label>
      <div class="row">
        <button class="ghost" id="scancel">取消</button>
        <button class="primary" id="ssave">保存并连接</button>
      </div>
    </div>
  `;

  const $ = (id) => root.getElementById(id);
  const elHL = $('hl'), elGWrap = $('gwrap'), elBadge = $('badge'), elInfo = $('info'), elBar = $('bar'), elGH = $('gh'),
        elGCLEAR = $('gclear'), elEscX = $('escx'),
        elFab = $('fab'), elCnt = $('cnt'), elDot = $('dot'), elCard = $('card'), elSel = $('sel'),
        elTxt = $('txt'), elOk = $('ok'), elCancel = $('cancel'), elToast = $('toast'),
        elPanel = $('panel'), elPH = $('ph'), elPlist = $('plist'), elPcount = $('pcount'), elPclose = $('pclose'),
        elPrompt = $('prompt'), elTCombo = $('tcombo'), elTInput = $('tinput'), elTDrop = $('tdrop'),
        elTRefresh = $('trefresh'),
        elSend = $('sendbtn'), elClear = $('clearbtn'),
        elSendGroup = $('sendgroup'), elSendMore = $('sendmore'), elSendMenu = $('sendmenu'), elCopyPrompt = $('copyprompt'),
        elConn = $('connstate'), elConnText = $('conntext'), elSettings = $('settings'),
        elSUrl = $('sburl'), elSSave = $('ssave'), elSCancel = $('scancel'), elSProps = $('sprops');

  let pos = { x: window.innerWidth - 68, y: window.innerHeight - 96 };
  try {
    const saved = sessionStorage.getItem(KEY_POS);
    if (saved) { const p = JSON.parse(saved); if (typeof p.x === 'number' && typeof p.y === 'number') pos = p; }
  } catch (e) { /* fall back to default position */ }
  // 视口缩小（如打开 devtools）后保存的位置可能落在可视区外，统一 clamp 回来
  function clampFabPos() {
    pos.x = Math.max(4, Math.min(window.innerWidth - 50, pos.x));
    pos.y = Math.max(4, Math.min(window.innerHeight - 50, pos.y));
  }
  clampFabPos();
  elFab.style.left = pos.x + 'px';
  elFab.style.top = pos.y + 'px';
  window.addEventListener('resize', () => {
    clampFabPos();
    elFab.style.left = pos.x + 'px';
    elFab.style.top = pos.y + 'px';
    try { sessionStorage.setItem(KEY_POS, JSON.stringify(pos)); } catch (err) { /* position won't persist */ }
  }, true);

  function toast(msg) {
    elToast.textContent = msg;
    elToast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => elToast.classList.remove('show'), 2200);
  }

  const els = { elHL, elGWrap, elBadge, elInfo, elBar, elGH, elGCLEAR, elEscX,
    elFab, elCnt, elDot, elCard, elSel, elTxt, elOk, elCancel, elToast,
    elPanel, elPH, elPlist, elPcount, elPclose, elPrompt, elTCombo, elTInput,
    elTDrop, elTRefresh, elSend, elClear, elSendGroup, elSendMore, elSendMenu,
    elCopyPrompt, elConn, elConnText, elSettings, elSUrl, elSSave, elSCancel, elSProps };

  // ---------- trigger 重注入 ----------
  // SPA 路由跳转 / HMR 热更新可能把 documentElement 下的外来节点清掉，host 一旦
  // 被移除 fab 就消失；脚本闭包里的状态都还在，把 host 重新挂回去即可整体恢复。
  function reinjectTrigger() {
    if (host.isConnected) return true;
    document.documentElement.appendChild(host);
    clampFabPos();
    elFab.style.left = pos.x + 'px';
    elFab.style.top = pos.y + 'px';
    return host.isConnected;
  }
  function observeHostRemoval() {
    if (!document.documentElement) return;
    new MutationObserver(() => { if (!host.isConnected) reinjectTrigger(); })
      .observe(document.documentElement, { childList: true });
  }
  if (document.documentElement) observeHostRemoval();
  else document.addEventListener('DOMContentLoaded', observeHostRemoval, { once: true });

  return { host, root, $, els, toast, clampFabPos, reinjectTrigger, get pos() { return pos; } };
}
