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
import { listLinks, listOwnLinks, sshDown, sshUp } from "../ssh-link.ts";
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

const baseOpts = { xferDir: localDir, myName: "self" as const, keyPath: path.join(os.homedir(), ".ssh", "id_ed25519_smoke") };
const opts = { ...baseOpts, direction: "in" as const, names: ["remote-alpha"] };
const childEnvSet = process.env.XFER_DIR;
// The remote env cannot cross ssh (AcceptEnv), so stage it in the remote
// user's home via the existing localhost connection — smoke-only mechanism.
fs.writeFileSync(path.join(os.homedir(), ".pi/xfer-ssh-env"), `export XFER_DIR=${JSON.stringify(remoteDir)}\n`);

try {
  const result = await sshUp("localhost", opts);
  console.log("sshUp:", result);
  assert(result.names.includes("remote-alpha"), "in imported remote-alpha");
  assert(fs.existsSync(path.join(localDir, "remote-alpha.sock")), "-L landing socket created locally");
  assert(!fs.existsSync(path.join(localDir, encodeAgentName("self") + ".json")), "in writes no self ledger entry");
  assert(!fs.existsSync(path.join(remoteDir, encodeAgentName("self") + ".sock")), "in leaves no -R landing on the remote");

  const links = listOwnLinks(baseOpts);
  assert(links.length === 1 && links[0].host === "localhost", "ledger lists exactly the imported entry");
  assert(links[0].name === "remote-alpha", "ledger entry names the remote node");

  await new Promise<void>((resolve, reject) => {
    const conn = net.connect({ path: path.join(localDir, "remote-alpha.sock") });
    conn.on("connect", () => { conn.destroy(); resolve(); });
    conn.on("error", reject);
    setTimeout(() => reject(new Error("tunnel connect timed out")), 5000);
  });
  assert(true, "-L tunnel connects end to end (local -> ssh -> remote listener)");

  const down = sshDown("localhost", baseOpts).torn;
  assert(down.length === 1, "sshDown tears down the -L entry");
  assert(!fs.existsSync(path.join(localDir, "remote-alpha.json")), "ledger json removed");

  // ── direction: in (import a remote node) ──
  const inResult = await sshUp("localhost", { ...baseOpts, direction: "in", names: ["remote-alpha"] });
  console.log("sshUp(in):", inResult);
  assert(inResult.names[0] === "remote-alpha", "in imported the named remote node");
  assert(fs.existsSync(path.join(localDir, "remote-alpha.sock")), "in created the local landing sock");
  assert(!fs.existsSync(path.join(localDir, encodeAgentName("self") + ".json")), "in writes no self entry");
  const inLinks = listOwnLinks(baseOpts);
  assert(inLinks.length === 1 && inLinks[0].name === "remote-alpha", "ledger lists the imported node");
  assert(sshDown("remote-alpha", baseOpts).torn.length === 1, "in Link tears down by forward name");

  // ── direction: out (export this pi) ──
  const outResult = await sshUp("localhost", { ...baseOpts, direction: "out" });
  console.log("sshUp(out):", outResult);
  assert(outResult.names[0] === "self", "out exported this pi under its own name");
  assert(fs.existsSync(path.join(remoteDir, encodeAgentName("self") + ".sock")), "out landed self.sock on the remote");
  assert(!fs.existsSync(path.join(localDir, "remote-alpha.sock")), "out imports nothing");
  const outLinks = listOwnLinks(baseOpts);
  assert(outLinks.length === 1 && outLinks[0].direction === "out", "ledger records the out direction");
  assert(sshDown("localhost", baseOpts).torn.length === 1, "out Link tears down by host");

  // ── in rejects an unknown remote name, naming what exists ──
  let rejected = "";
  try {
    await sshUp("localhost", { ...baseOpts, direction: "in", names: ["nope"] });
  } catch (err) {
    rejected = err instanceof Error ? err.message : String(err);
  }
  assert(/not found on localhost: nope/.test(rejected) && /remote-alpha/.test(rejected),
    "in rejects an unknown remote name and lists the real ones");

  // ── a foreign pi's Link is not ours to tear down ──
  fs.writeFileSync(path.join(localDir, "foreign.json"), JSON.stringify({ via: "ssh", host: "localhost", pid: 999999, owner: 999999, direction: "in" }));
  assert(sshDown(undefined, baseOpts).torn.length === 0, "sshDown leaves a foreign Link alone");
  assert(listLinks(baseOpts).length === 1, "the foreign Link record survives");
  fs.unlinkSync(path.join(localDir, "foreign.json"));
  console.log("\nALL PASS");
} finally {
  if (childEnvSet === undefined) delete process.env.XFER_DIR; else process.env.XFER_DIR = childEnvSet;
  fs.rmSync(path.join(os.homedir(), ".pi/xfer-ssh-env"), { force: true });
  remoteServer.close();
  sshDown("localhost", baseOpts); // leave nothing behind on failure paths
  console.log(`(artifacts left at ${base} for inspection)`);
}
