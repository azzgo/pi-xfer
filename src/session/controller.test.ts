/**
 * controller.test.ts — inbound envelope assembly, including the P1-D sender-cwd
 * instruction line: local vs mesh sender, unstamped (older) senders, and the
 * web-picker sender that must stay anchor-free.
 *
 * Hermetic: a fake `pi` captures sendMessage calls, `XferState` is fresh (no
 * identity → no metadata writes), and docs are synthetic files in a fresh
 * `os.tmpdir()` sandbox.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { XferController } from "./controller.ts";
import { senderCwdStampFor, stampDocument } from "./sender-cwd-stamp.ts";
import { stampHandoffKind, type HandoffKind } from "../core/handoff-kind.ts";
import { XferState } from "./state.ts";
import type { XferNotifyMessage } from "../core/types.ts";
import { FROM_WEB_PICKER } from "../core/wire.ts";

interface Sent { customType: string; content: string }

let sandbox: string;
let sent: Sent[];

before(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-controller-test-")); });
after(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

/** Fresh controller whose peer dir is the sandbox — never the real ~/.pi/xfer. */
function controller(xferDir = sandbox): XferController {
  sent = [];
  const pi = { sendMessage: (message: Sent) => sent.push(message) };
  return new XferController(pi as never, new XferState(), xferDir);
}

let docSeq = 0;

function doc(stamp?: ReturnType<typeof senderCwdStampFor>, kind?: HandoffKind): string {
  const file = path.join(sandbox, `pi-xfer-${docSeq++}.md`);
  const body = "# Handoff\n\ndo the thing\n";
  const stamped = stamp ? stampDocument(body, stamp) : body;
  fs.writeFileSync(file, kind ? stampHandoffKind(stamped, kind) : stamped, "utf-8");
  return file;
}

function notify(file: string, from = "alpha"): XferNotifyMessage {
  return { type: "xfer-notify", msg_id: "m1", from, file, summary: "Review src/server.ts" };
}

function deliver(msg: XferNotifyMessage, transport?: "mesh" | "ssh"): string {
  controller().deliverInbound(msg, transport);
  assert.equal(sent.length, 1);
  return sent[0]!.content;
}

describe("inbound envelope: sender cwd anchoring", () => {
  it("anchors a local agent sender on its cwd", () => {
    const file = doc(senderCwdStampFor("/srv/app", os.hostname()));
    const content = deliver(notify(file));
    assert.match(
      content,
      /\*\*Sender cwd\*\*: `\/srv\/app` \(project app on machine [^\)]+\) — make all file edits here unless the doc says otherwise\./,
    );
    assert.doesNotMatch(content, /does not exist on this machine/);
  });

  it("adds the locate-the-project fallback for a mesh sender on another machine", () => {
    const content = deliver(notify(doc(senderCwdStampFor("/srv/app", "some-other-host"))), "mesh");
    assert.match(content, /\*\*Sender cwd\*\*: `\/srv\/app`/);
    assert.match(content, /does not exist on this machine, locate the project/);
    assert.match(content, /Xfer from \*\*alpha\*\* · mesh/);
  });

  it("treats a non-mesh sender from another host as remote", () => {
    const content = deliver(notify(doc(senderCwdStampFor("/srv/app", "some-other-host"))));
    assert.match(content, /does not exist on this machine, locate the project/);
  });

  it("omits the line for docs from senders that predate the stamp", () => {
    const content = deliver(notify(doc()));
    assert.doesNotMatch(content, /Sender cwd/);
    assert.match(content, /\*\*Doc\*\*: `.*\.md`\n\nRead the doc and handle the request\./);
  });

  it("omits the line for a refused misroute with no readable doc", () => {
    const content = deliver(notify({ ...notify("/nonexistent/pi-xfer-x.md"), file: "(refused — misrouted)" }));
    assert.doesNotMatch(content, /Sender cwd/);
  });

  it("keeps web-picker senders anchor-free and steered to the page-tool CLI", () => {
    const content = deliver(notify(doc(senderCwdStampFor("/srv/app", os.hostname())), FROM_WEB_PICKER));
    assert.doesNotMatch(content, /Sender cwd/);
    assert.match(content, /browser userscript/);
    assert.match(content, /page-tool/);
  });
});

describe("inbound envelope: handoff kind", () => {
  it("carries the sender's handoff id and declared kind into the envelope", () => {
    const content = deliver(notify(doc(senderCwdStampFor("/srv/app", os.hostname()), "task")));
    assert.match(content, /\*\*Handoff\*\*: `m1` — kind: task/);
  });

  it("obliges exactly one conclusion for a task, and says which kind carries it", () => {
    const content = deliver(notify(doc(undefined, "task")));
    assert.match(content, /This handoff is a \*\*Task\*\*/);
    assert.match(content, /Send exactly one reverse handoff to `alpha`/);
    assert.match(content, /declare its kind deliberately/);
    assert.match(content, /`notification` when it carries that conclusion, which closes the exchange/);
    assert.match(content, /`task` when you are blocked/);
    assert.doesNotMatch(content, /Do not reply/);
  });

  it("stays silent for a notification, asking for the answer kind when one is unavoidable", () => {
    const content = deliver(notify(doc(undefined, "notification")));
    assert.match(content, /This handoff is a \*\*Notification\*\*/);
    assert.match(content, /Do not reply/);
    assert.match(content, /declare it `task` when you need something back/);
    assert.doesNotMatch(content, /Send exactly one reverse handoff/);
  });

  it("reads a doc with no kind line as a notification", () => {
    const content = deliver(notify(doc()));
    assert.match(content, /\*\*Handoff\*\*: `m1` — kind: notification/);
    assert.match(content, /Do not reply/);
  });

  it("believes the doc's first kind line over a later one", () => {
    const file = path.join(sandbox, `pi-xfer-${docSeq++}.md`);
    fs.writeFileSync(file, "kind: task\n\nkind: notification\n", "utf-8");
    const content = deliver(notify(file));
    assert.match(content, /kind: task/);
    assert.match(content, /asks you for output/);
  });
});
describe("inbound routing: idle vs busy", () => {
  function routed(options: { idle: boolean; pending: boolean }): string {
    const calls: Array<{ deliverAs?: string; triggerTurn?: boolean }> = [];
    const pi = {
      sendMessage: (_m: unknown, opts: { deliverAs?: string; triggerTurn?: boolean }) => calls.push(opts),
    };
    const state = new XferState();
    state.runtimeContext = {
      isIdle: () => options.idle,
      hasPendingMessages: () => options.pending,
    } as never;
    new XferController(pi as never, state).deliverInbound(notify(doc()));
    assert.equal(calls.length, 1);
    return calls[0]!.deliverAs ?? "(none)";
  }

  it("opens a new turn when the session is idle and nothing is queued", () => {
    assert.equal(routed({ idle: true, pending: false }), "followUp");
  });

  it("steers when the session is idle but a message is still queued", () => {
    assert.equal(routed({ idle: true, pending: true }), "steer");
  });

  it("steers when the session is busy", () => {
    assert.equal(routed({ idle: false, pending: false }), "steer");
  });
});

describe("inbound: ssh Link frames carry their document inline", () => {
  it("materialises the document locally when the frame has no readable file", () => {
    const body = "# Handoff\n\ninline body\n";
    controller().deliverInbound(
      { type: "xfer-notify", msg_id: "link-1", from: "remote-alpha", document: body, summary: "do it", via: "ssh" },
      "ssh",
    );
    const text = sent.at(-1)!.content;
    assert.match(text, /Xfer from \*\*remote-alpha\*\* · ssh/);
    const docPath = /\*\*Doc\*\*: `([^`]+)`/.exec(text)?.[1];
    assert.ok(docPath, "the envelope names a local doc path");
    assert.equal(fs.readFileSync(docPath!, "utf-8"), body, "the body landed in a local tmp file");
    assert.match(text, /ssh Link/);
    assert.match(text, /tunnel is bidirectional/);
  });

  it("never treats a Link sender as local even when hostnames match", () => {
    const body = `# Handoff\n\n`;
    controller().deliverInbound(
      { type: "xfer-notify", msg_id: "link-2", from: "remote-alpha", document: body, summary: "x", via: "ssh" },
      "ssh",
    );
    const text = sent.at(-1)!.content;
    assert.doesNotMatch(text, /make all file edits here/);
  });
});

describe("inbound: the envelope's kind wins over the body", () => {
  it("honours a task declared in the frame even when the doc is missing", () => {
    controller().deliverInbound(
      { type: "xfer-notify", msg_id: "k1", from: "remote-alpha", document: "", summary: "do it", kind: "task", via: "ssh" },
      "ssh",
    );
    const text = sent.at(-1)!.content;
    assert.match(text, /kind: task/);
    assert.match(text, /asks you for output/);
  });

  it("says plainly when no document arrived, and forbids hunting for it", () => {
    controller().deliverInbound(
      { type: "xfer-notify", msg_id: "k2", from: "remote-alpha", summary: "just this", kind: "notification", via: "ssh" },
      "ssh",
    );
    const text = sent.at(-1)!.content;
    assert.match(text, /\(none — the sender's document did not arrive\)/);
    assert.match(text, /Do not search this machine/);
    assert.doesNotMatch(text, /undefined/);
  });

  it("still reads the body's line for senders that predate the field", () => {
    const file = doc(senderCwdStampFor("/srv/app", os.hostname()), "task");
    const text = deliver(notify(file));
    assert.match(text, /kind: task/);
  });
});

describe("inbound: ssh Link is bidirectional by construction", () => {
  it("states that a reply has a route, without asking the receiver to guess", () => {
    controller().deliverInbound(
      { type: "xfer-notify", msg_id: "b1", from: "remote-alpha", document: "# x\n", summary: "s", kind: "task", via: "ssh" },
      "ssh",
    );
    const text = sent.at(-1)!.content;
    assert.match(text, /tunnel is bidirectional/);
    assert.match(text, /has a route/);
    assert.doesNotMatch(text, /no verified return channel/);
    assert.doesNotMatch(text, /peer not found/);
  });

  it("does not require the receiver to downgrade a task", () => {
    controller().deliverInbound(
      { type: "xfer-notify", msg_id: "b2", from: "remote-alpha", document: "# x\n", summary: "s", kind: "task", via: "ssh" },
      "ssh",
    );
    const text = sent.at(-1)!.content;
    assert.match(text, /kind: task/);
    assert.match(text, /asks you for output/);
  });
});

describe("inbound: the web-picker delivery names the page-tool channel first", () => {
  it("puts the channel before the request, with a runnable command", () => {
    const content = deliver({
      type: "xfer-notify",
      msg_id: "w1",
      from: FROM_WEB_PICKER,
      file: doc(),
      summary: "collect the notes",
    });
    const channel = content.indexOf("page-tool");
    assert.ok(channel > 0, "the delivery names the channel");
    assert.ok(channel < content.indexOf("**Request**"), "the channel comes before the request");
    assert.match(content, /Do not open a browser/i);
    assert.match(content, /dist\/broker\.cjs/, "the example command points at the shipped bundle");
    assert.match(content, /--tab <tabId>/);
  });
});

describe("inbound: document integrity against the sender's hash", () => {
  const body = "# Handoff\n\npayload\n";
  const sha = (t: string) => createHash("sha256").update(t, "utf-8").digest("hex");

  it("records `verified` when the body matches the sender's hash", () => {
    const c = controller();
    c.deliverInbound({
      type: "xfer-notify", msg_id: "i1", from: "remote", document: body,
      summary: "s", via: "ssh", docSha256: sha(body),
    }, "ssh");
    assert.equal(c.lastIntegrity, "verified");
  });

  it("records `mismatch` when the body was altered before arrival", () => {
    const c = controller();
    c.deliverInbound({
      type: "xfer-notify", msg_id: "i2", from: "remote", document: body,
      summary: "s", via: "ssh", docSha256: sha("something else entirely"),
    }, "ssh");
    assert.equal(c.lastIntegrity, "mismatch");
  });

  it("stays undefined for a frame that carried no hash", () => {
    const c = controller();
    c.deliverInbound({ type: "xfer-notify", msg_id: "i3", from: "remote", document: body, summary: "s" }, "ssh");
    assert.equal(c.lastIntegrity, undefined);
  });
});
