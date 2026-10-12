// One-off generator for docs/guides/assets/architecture.excalidraw
const fs = require("node:fs");

let seed = 1;
const S = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);

const base = (over) => ({
  id: over.id,
  type: over.type,
  x: over.x, y: over.y,
  width: over.width ?? 100, height: over.height ?? 100,
  angle: 0,
  strokeColor: over.strokeColor ?? "#1e1e1e",
  backgroundColor: over.backgroundColor ?? "transparent",
  fillStyle: "solid",
  strokeWidth: over.strokeWidth ?? 1,
  strokeStyle: over.strokeStyle ?? "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: over.type === "rectangle" || over.type === "diamond" ? { type: 3 } : null,
  seed: S(),
  version: 1,
  versionNonce: S(),
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
});

const rect = (id, x, y, w, h, label, bg = "transparent", stroke = "#1e1e1e") =>
  base({ id, type: "rectangle", x, y, width: w, height: h, backgroundColor: bg, strokeColor: stroke, strokeWidth: 2 });

const text = (id, x, y, label, size = 16, color = "#1e1e1e") => {
  const lines = label.split("\n");
  const e = base({ id, type: "text", x, y, width: 10, height: lines.length * size * 1.25, strokeColor: color });
  return { ...e, text: label, fontSize: size, fontFamily: 1, textAlign: "center", verticalAlign: "top",
    containerId: null, originalText: label, lineHeight: 1.25, baseline: (lines.length - 1) * size };
};

const arrow = (id, x1, y1, x2, y2, label, color = "#1e1e1e", style = "solid") => {
  const e = base({ id, type: "arrow", x: x1, y: y1, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
    strokeColor: color, strokeStyle: style, strokeWidth: 2 });
  return { ...e, points: [[0, 0], [x2 - x1, y2 - y1]], lastCommittedPoint: null,
    startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: "triangle",
    elbowed: false };
};

const E = [];
const L = (id, x, y, w, h, label, bg, stroke) => E.push(rect(id, x, y, w, h, label, bg, stroke));
const T = (id, x, y, s, size, c) => E.push(text(id, x, y, s, size, c));
const A = (...a) => E.push(arrow(...a));

// Title
T("t0", 470, 24, "pi-xfer — how a handoff travels", 24);

// Layer 1: peer transport
L("l1", 40, 90, 1120, 190, "", "#f3f9ff", "#1971c2");
T("l1t", 60, 102, "1 · Peer transport — default path (same machine, no setup)", 16, "#1971c2");
L("a1", 90, 170, 180, 80, "", "#d0ebff", "#1971c2");
T("a1t", 105, 198, "pi session “alpha”", 16);
L("sock", 460, 170, 280, 80, "", "#e9ecef", "#495057");
T("sockt", 480, 188, "~/.pi/xfer/<name>.sock\nUnix-socket peer listener", 14);
L("b1", 930, 170, 180, 80, "", "#d3f9d8", "#2f9e44");
T("b1t", 945, 198, "pi session “beta”", 16);
A("ar1", 270, 210, 460, 210, "handoff", "#1971c2");
A("ar2", 740, 210, 930, 210, "handoff", "#1971c2");

// Layer 2: broker / web picker
L("l2", 40, 320, 1120, 180, "", "#fff9db", "#e8590c");
T("l2t", 60, 332, "2 · Broker — web picker (optional)", 16, "#e8590c");
L("brw", 90, 390, 220, 80, "", "#ffec99", "#e8590c");
T("brwt", 110, 418, "Browser + userscript", 16);
L("brk", 460, 390, 280, 80, "", "#fff3bf", "#e8590c");
T("brkt", 490, 408, "Broker daemon\n/xfer broker start", 14);
A("ar3", 310, 430, 460, 430, "picks · records", "#e8590c");
A("ar4", 460, 390, 200, 250, "submit handoff", "#e8590c", "dashed");

// Layer 3: mesh
L("l3", 40, 540, 1120, 200, "", "#f8f0fc", "#9c36b5");
T("l3t", 60, 552, "3 · Mesh — opt-in cross-machine (RivetKit actor network)", 16, "#9c36b5");
L("n1", 90, 620, 200, 80, "", "#eebefa", "#9c36b5");
T("n1t", 105, 648, "Node (machine 1)", 16);
L("eng", 460, 620, 280, 80, "", "#f3d9fa", "#9c36b5");
T("engt", 480, 638, "Engine / control plane\ndiscovery · durable queue", 14);
L("n2", 910, 620, 200, 80, "", "#eebefa", "#9c36b5");
T("n2t", 925, 648, "Node (machine 2)", 16);
A("ar5", 290, 660, 460, 660, "", "#9c36b5");
A("ar6", 740, 660, 910, 660, "handoff", "#9c36b5");
A("ar7", 190, 540, 190, 250, "join: /xfer mesh up", "#9c36b5", "dashed");

const scene = {
  type: "excalidraw", version: 2, source: "pi-xfer",
  elements: E,
  appState: { viewBackgroundColor: "#ffffff", gridSize: null },
  files: {},
};
fs.writeFileSync(__dirname + "/architecture.excalidraw", JSON.stringify(scene, null, 2));
console.log("wrote", E.length, "elements");
