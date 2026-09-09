// Shared constants — storage keys, caps, hotkey definition.
// Storage contract: existing keys stay `pi.wp.*`; the two GM connection keys keep
// the round-trial names (no `pi.` prefix) for continuity.

export const KEY_PICKS = 'pi.wp.picks';          // per-tab batch (sessionStorage)
export const KEY_POS = 'pi.wp.fabPos';           // fab position (sessionStorage)
export const KEY_BAR_POS = 'pi.wp.barPos';       // pick toolbar position (sessionStorage)
export const KEY_PANEL_POS = 'pi.wp.panelPos';   // note panel position (sessionStorage)
export const GM_DEBUG = 'pi.wp.debug';           // debug flag (GM storage)
export const HOST_FLAG = 'data-pi-wp-host';
export const MAX_DEPTH = 8;
export const HOTKEY = { code: 'KeyP', alt: true, shift: true };
export const GM_BROKER = 'wp.brokerUrl';        // broker WS URL override (settings modal)
export const GM_TARGET = 'wp.lastTarget';       // last used local target name
export const GM_FPROPS = 'wp.frameworkProps';   // framework.inspect props/state opt-in (default off)
export const DEFAULT_BROKER_URL = 'ws://127.0.0.1:4719';

// page-tool capture/result caps + computed-style defaults (v1.6)
export const CAPTURE_MAX = 200;                 // ring buffer size for console/network entries
export const RESULT_MAX_CHARS = 500000;         // page.response text budget (broker frames cap at 1MB)
export const DEFAULT_STYLE_PROPS = ['display', 'position', 'color', 'background-color', 'font-size',
  'font-weight', 'font-family', 'line-height', 'text-align', 'overflow', 'z-index', 'opacity',
  'visibility', 'width', 'height', 'margin', 'padding', 'border', 'border-radius',
  'flex-direction', 'gap'];
