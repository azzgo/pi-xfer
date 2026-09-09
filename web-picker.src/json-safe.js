// JSON-safe serialization: drops/flat-marks everything a JSON round trip
// cannot carry (functions, symbols, cycles via depth cap, huge strings).

export const JSON_SAFE_CAPS = { maxDepth: 5, maxStr: 100000, maxArray: 500, maxKeys: 200 };

export function jsonSafe(value) {
  let truncated = false;
  function walk(v, depth) {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (v === undefined) return null;
    if (typeof v === 'bigint' || typeof v === 'symbol') { truncated = true; return String(v); }
    if (typeof v === 'function') { truncated = true; return 'ƒ ' + (v.name || 'anonymous'); }
    if (typeof v === 'string') {
      if (v.length > JSON_SAFE_CAPS.maxStr) { truncated = true; return v.slice(0, JSON_SAFE_CAPS.maxStr) + '…[truncated]'; }
      return v;
    }
    if (v instanceof Error) {
      return { name: v.name, message: v.message, stack: walk(v.stack == null ? '' : String(v.stack), depth + 1) };
    }
    if (depth >= JSON_SAFE_CAPS.maxDepth) { truncated = true; return '[maxDepth]'; }
    if (Array.isArray(v)) {
      if (v.length > JSON_SAFE_CAPS.maxArray) truncated = true;
      return v.slice(0, JSON_SAFE_CAPS.maxArray).map((x) => walk(x, depth + 1));
    }
    if (typeof v !== 'object') { truncated = true; return String(v); }
    const out = {};
    let keys;
    try { keys = Object.keys(v); } catch (e) { truncated = true; return '[uninspectable]'; }
    if (keys.length > JSON_SAFE_CAPS.maxKeys) truncated = true;
    for (const k of keys.slice(0, JSON_SAFE_CAPS.maxKeys)) {
      try { out[k] = walk(v[k], depth + 1); } catch (e) { truncated = true; out[k] = '[error]'; }
    }
    return out;
  }
  let text;
  try { text = JSON.stringify(walk(value, 0)); }
  catch (e) { truncated = true; text = '"[unserializable]"'; }
  return { text: text === undefined ? 'null' : text, truncated };
}
