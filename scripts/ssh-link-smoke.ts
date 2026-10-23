/**
 * Manual smoke for ssh-link.ts (ADR-0021) — run under tmux:
 *   node --import ./ts-resolve-hook.mjs scripts/ssh-link-smoke.ts
 *
 * Uses `ssh localhost` as the "remote" machine. The remote xfer dir is a
 * temp dir (exported as XFER_DIR so the probe sees it), holding one fake
 * remote node sock with a live listener. Verifies:
 *   1. probe finds the remote dir + node
 *   2. sshUp creates the -L landing sockets + Link json ledger
 *   3. -R lands self.sock in the remote dir
 *   4. the -L tunnel actually connects end to end
 *   5. sshDown kills the pid and removes the ledger files
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { listLinks, sshDown, sshUp } from "../ssh-link.ts";
import { encodeAgentName } from "../utils.ts";

const assert = (cond: unknown, what: string): void => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok — ${what}`);
};

const base = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-ssh-smoke-"));
const localDir = path.join(base, "local");
const remoteDir = path.join(base, "remote");
fs.mkdirSync(localDir, { recursive: true });
fs.mkdirSync(remoteDir, { recursive: true });

const forwardEnv = { ...process.env, XFER_DIR: remoteDir };

// Fake remote node: a listener on <remoteDir>/remote-alpha.sock
const remoteServer = net.createServer(() => {});
await new Promise<void>(resolve => remoteServer.listen(path.join(remoteDir, "remote-alpha.sock"), resolve));
console.log(`fake remote node listening at ${remoteDir}/remote-alpha.sock`);

const opts = { xferDir: localDir, myName: "self", keyPath: path.join(os.homedir(), ".ssh", "id_ed25519_smoke") };
const childEnvSet = process.env.XFER_DIR;
// The remote env cannot cross ssh (AcceptEnv), so stage it in the remote
// user's home via the existing localhost connection — smoke-only mechanism.
fs.writeFileSync(path.join(os.homedir(), ".pi/xfer-ssh-env"), `export XFER_DIR=${JSON.stringify(remoteDir)}\n`);

try {
  const result = await sshUp("localhost", opts);
  console.log("sshUp:", result);
  assert(result.forwardNames.includes("remote-alpha"), "probe found remote-alpha");
  assert(fs.existsSync(path.join(localDir, "remote-alpha.sock")), "-L landing socket created locally");
  assert(fs.existsSync(path.join(localDir, encodeAgentName("self") + ".json")), "self Link json written");
  assert(fs.existsSync(path.join(remoteDir, encodeAgentName("self") + ".sock")), "-R landed self.sock on the remote");

  const links = listLinks(opts);
  // remote-alpha (-L) plus self (-R) — both ledger entries share one ssh pid.
  assert(links.length === 2 && links.every(l => l.host === "localhost"), "ledger lists both Link entries");
  assert(links[0].pid === links[1].pid, "both entries share the ssh pid");

  await new Promise<void>((resolve, reject) => {
    const conn = net.connect({ path: path.join(localDir, "remote-alpha.sock") });
    conn.on("connect", () => { conn.destroy(); resolve(); });
    conn.on("error", reject);
    setTimeout(() => reject(new Error("tunnel connect timed out")), 5000);
  });
  assert(true, "-L tunnel connects end to end (local -> ssh -> remote listener)");

  const down = sshDown("localhost", opts);
  assert(down.length === 2, "sshDown tears down both Link entries");
  assert(!fs.existsSync(path.join(localDir, "remote-alpha.json")), "ledger json removed");
  // StreamLocalBindUnlink is bind-time cleanup, NOT exit-time: the -R sock is
  // EXPECTED to linger after ssh dies; the remote's own gc reaps it as an
  // orphan-sock (ECONNREFUSED) — the designed path, not a failure.
  const remoteSelf = path.join(remoteDir, encodeAgentName("self") + ".sock");
  console.log(fs.existsSync(remoteSelf)
    ? "(remote -R sock lingers after exit — expected; the remote's gc owns it as an orphan)"
    : "(remote -R sock already gone)");
  console.log("\nALL PASS");
} finally {
  if (childEnvSet === undefined) delete process.env.XFER_DIR; else process.env.XFER_DIR = childEnvSet;
  fs.rmSync(path.join(os.homedir(), ".pi/xfer-ssh-env"), { force: true });
  remoteServer.close();
  sshDown("localhost", opts); // leave nothing behind on failure paths
  console.log(`(artifacts left at ${base} for inspection)`);
}
