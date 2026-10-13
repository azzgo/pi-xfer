// Offline handoff composer — the picker-side twin of the broker's
// renderHandoffDoc (broker-main.ts), used when the local broker is not
// reachable (CSP-blocked page, broker down, or simply never linked).
//
// Same document shape, two deliberate differences:
//   - NO "Follow-up channel" section. That channel is a live page-tool command
//     against this tab's broker connection; with no broker there is nothing to
//     query, so advertising it would be a lie the receiving agent trips over.
//   - The picks and the recorded timeline carry the whole record, so the
//     document stands alone: save it, open it in an agent session, done.
//
// Pure string building (no DOM, no GM, no protocol) so it is unit-testable.

/** One pick in the `payloadFor()` schema the submit frame carries. */
function pickSection(pick, index) {
  const lines = [
    '### ' + (index + 1) + '. ' + (pick.selector || '(no selector)'),
    '',
    '- xpath: ' + (pick.xpath || ''),
    '- text: ' + (pick.textPreview || ''),
  ];
  if (pick.attributes && Object.keys(pick.attributes).length) {
    const attrs = Object.keys(pick.attributes).slice(0, 20)
      .map((k) => pick.attributes[k] ? k + '="' + pick.attributes[k] + '"' : k);
    if (attrs.length) lines.push('- attrs: ' + attrs.join(' '));
  }
  const r = pick.rect || {};
  lines.push('- rect: x=' + (r.x || 0) + ' y=' + (r.y || 0) + ' w=' + (r.w || 0) + ' h=' + (r.h || 0));
  lines.push('- note: ' + (pick.note || ''));
  if (pick.group) lines.push('- group: ' + pick.group);
  if (pick.source && pick.source.file) lines.push('- source: ' + pick.source.file + ':' + pick.source.line);
  lines.push('');
  return lines;
}

const RECORD_SCENE_MAX = 40;

function recordEventLine(ev) {
  const parts = ['+`' + ev.t + 'ms`', '`' + ev.kind + '`'];
  if (ev.sel) parts.push('`' + ev.sel + '`');
  if (ev.kind === 'input' && ev.value !== undefined) parts.push('value=`' + ev.value + '`');
  if (ev.kind === 'key' && ev.key) parts.push('key=`' + ev.key + '`');
  if (ev.kind === 'nav' && ev.to) parts.push('→ ' + ev.to);
  if (ev.text) parts.push('— "' + ev.text + '"');
  if (ev.ref) parts.push('(pick #' + ev.ref + ')');
  return '- ' + parts.join(' ');
}

function recordSection(rec) {
  const lines = [
    '## Operation timeline',
    '',
    '- record: ' + rec.id,
    '- span: ' + rec.start + (rec.end ? ' → ' + rec.end : '') +
      ' (' + new Date(rec.start).toISOString() + (rec.end ? ' → ' + new Date(rec.end).toISOString() : '') + ')',
    '- url: ' + (rec.url1 && rec.url1 !== rec.url0 ? rec.url0 + ' → ' + rec.url1 : (rec.url0 || '')),
    '',
    'The user reproduced the problem by hand while the picker recorded. Events are ordered (`seq`) with millisecond offsets (`t`); `input` values are final field values (passwords masked).',
    '',
  ];
  for (const ev of (rec.events || [])) lines.push(recordEventLine(ev));
  lines.push('');
  if (rec.net && rec.net.length) {
    lines.push('### Network (window slice)', '');
    for (const n of rec.net.slice(-RECORD_SCENE_MAX)) {
      const status = n.pending ? 'pending' : String(n.status === undefined ? '?' : n.status);
      const sse = n.kind === 'sse' ? ' sse' + (n.msgs !== undefined ? ' msgs=' + n.msgs : '') : '';
      const dur = n.durationMs !== undefined ? ' ' + n.durationMs + 'ms' : '';
      lines.push('- ' + (n.method || '?') + ' ' + (n.url || '?') + ' → ' + status + sse + dur + (n.error ? ' error="' + n.error + '"' : ''));
    }
    lines.push('');
  }
  if (rec.console && rec.console.length) {
    lines.push('### Console (window slice)', '');
    for (const c of rec.console.slice(-RECORD_SCENE_MAX)) {
      lines.push('- [' + (c.level || 'log') + '] ' + (c.text || ''));
    }
    lines.push('');
  }
  return lines;
}

/**
 * Render the full handoff document from data already in the tab.
 *
 * @param {object} input
 * @param {string} input.prompt   User request text (already defaulted).
 * @param {object} input.page    { url, title, ts } captured from this tab.
 * @param {Array}  input.picks   The pick batch (payloadFor() records).
 * @param {object} [input.record] Completed Record-mode capture, when present.
 * @param {string} [input.target]  Last used local target — a hint only, never
 *                                 required: the receiver opens this file itself.
 */
export function renderOfflineHandoffDoc({ prompt, page, picks, record, target }) {
  const ts = (page && page.ts) || Date.now();
  const lines = [
    '# Web annotation handoff',
    '',
    '## Request',
    '',
    prompt || '',
    '',
    '## Page',
    '',
    '- url: ' + ((page && page.url) || ''),
    '- title: ' + ((page && page.title) || ''),
    '- ts: ' + ts + ' (' + new Date(ts).toISOString() + ')',
    '',
  ];
  if (target) lines.push('- expected receiver: ' + target);
  if (target) lines.push('');

  lines.push('## Annotations', '');
  const list = Array.isArray(picks) ? picks : [];
  if (!list.length) lines.push('_No elements were picked on this page._', '');
  list.forEach((pick, i) => { lines.push(...pickSection(pick || {}, i)); });
  if (record) lines.push(...recordSection(record));

  lines.push(
    '## Offline composition',
    '',
    'This document was assembled inside the browser tab by the pi-xfer web-picker userscript: the local broker was not reachable, so **there is no way to query this page later** (no reverse channel, no live browser link). Everything you need is above — the picks, the recorded operation timeline, and its console/network slices. Treat this document as the complete record of what the user saw and did.',
    '',
    '---',
    '',
    'from: web-picker (browser userscript — composed offline in the tab, no broker link; save this file and open it in an agent session)',
    'handoff_id: local-' + ts,
  );
  return lines.join('\n') + '\n';
}