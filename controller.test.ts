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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { XferController } from "./controller.js";
import { senderCwdStampFor, stampDocument } from "./sender-cwd-stamp.js";
import { XferState } from "./state.js";
import type { XferNotifyMessage } from "./types.js";
import { FROM_WEB_PICKER } from "./wire.js";

interface Sent { customType: string; content: string }

let sandbox: string;
let sent: Sent[];

before(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-controller-test-")); });
after(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

function controller(): XferController {
  sent = [];
  const pi = { sendMessage: (message: Sent) => sent.push(message) };
  return new XferController(pi as never, new XferState());
}

let docSeq = 0;

function doc(stamp?: ReturnType<typeof senderCwdStampFor>): string {
  const file = path.join(sandbox, `pi-xfer-${docSeq++}.md`);
  const body = "# Handoff\n\ndo the thing\n";
  fs.writeFileSync(file, stamp ? stampDocument(body, stamp) : body, "utf-8");
  return file;
}

function notify(file: string, from = "alpha"): XferNotifyMessage {
  return { type: "xfer-notify", msg_id: "m1", from, file, summary: "Review src/server.ts" };
}

function deliver(msg: XferNotifyMessage, transport?: "mesh"): string {
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