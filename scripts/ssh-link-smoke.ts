/**
 * Manual smoke for ssh-link.ts (ADR-0021) — run under tmux:
 *   node --import ./ts-resolve-hook.mjs scripts/ssh-link-smoke.ts
 *
 * Uses `ssh localhost` as the "remote" machine. The remote xfer dir is a temp
 * dir staged in ~/.pi/xfer-ssh-env (XFER_DIR cannot cross ssh: sshd's AcceptEnv
 * does not allow it) holding one fake remote node sock with a live listener.
 *
 * Covers what a Link actually is now: ONE ssh process carrying -L for every
 * imported name and -R for this pi, so both directions exist by construction.
 *   - `in a` then `in b` accumulates, never replaces
 *   - the remote ends up with a `role: reverse` marker for this pi (no pid)
 *   - down tears the host Link down as a unit
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

const servers: net.Server[] = [];
async function fakeNode(name: string): Promise<void> {
  const server = net.createServer(() => {});
  servers.push(server);
  await new Promise<void>(resolve => server.listen(path.join(remoteDir, `${name}.sock`), resolve));
}

await fakeNode("alpha");
await fakeNode("beta");
// This pi's own listener: the -R target. A real pi binds it at session start.
const selfServer = net.createServer(() => {});
servers.push(selfServer);
await new Promise<void>(resolve => selfServer.listen(path.join(localDir, "mac-xfer.sock"), resolve));
console.log(`fake remote nodes in ${remoteDir}`);

const opts = { xferDir: localDir, myName: "mac-xfer", keyPath: path.join(os.homedir(), ".ssh", "id_ed25519_smoke") };
fs.writeFileSync(path.join(os.homedir(), ".pi/xfer-ssh-env"), `export XFER_DIR=${JSON.stringify(remoteDir)}\n`);

try {
  // ── first import ──
  const first = await sshUp("localhost", { ...opts, names: ["alpha"] });
  console.log("sshUp(alpha):", first);
  assert(first.names.join(",") === "alpha", "imports alpha");
  assert(fs.existsSync(path.join(localDir, "alpha.sock")), "-L landing created locally");
  assert(fs.existsSync(path.join(remoteDir, "mac-xfer.sock")), "-R landed this pi on the remote");
  assert(fs.existsSync(path.join(localDir, "mac-xfer.sock")), "this pi's own socket is the -R target");

  // The imported socket gets its own marker HERE, so this side knows the peer
  // is a Link (inline the document) rather than a plain local peer.
  const importMarker = JSON.parse(fs.readFileSync(path.join(localDir, "alpha.json"), "utf-8"));
  assert(importMarker.role === "import", "the imported socket got a role:import marker");
  assert(importMarker.via === "ssh", "…marked as an ssh Link");
  assert(importMarker.pid === undefined, "…with no local pid, since the process is remote");

  const reverseMarker = JSON.parse(fs.readFileSync(path.join(remoteDir, "mac-xfer.json"), "utf-8"));
  assert(reverseMarker.role === "reverse", "the remote got a role:reverse marker");
  assert(reverseMarker.via === "ssh", "…marked as an ssh Link");
  assert(reverseMarker.pid === undefined, "…and deliberately carries no pid");

  // ── accumulate, not replace ──
  const second = await sshUp("localhost", { ...opts, names: ["beta"] });
  console.log("sshUp(beta):", second);
  assert(second.names.sort().join(",") === "alpha,beta", "the second run keeps alpha and adds beta");
  assert(second.added.join(",") === "beta", "only beta counts as added");
  assert(fs.existsSync(path.join(localDir, "alpha.sock")), "alpha landing survives the rebuild");
  assert(fs.existsSync(path.join(localDir, "beta.sock")), "beta landing created");
  assert(listOwnLinks(opts).length === 1, "still exactly one Link for this host");

  // ── both directions are actually usable ──
  for (const name of ["alpha", "beta"]) {
    await new Promise<void>((resolve, reject) => {
      const conn = net.connect({ path: path.join(localDir, `${name}.sock`) });
      conn.on("connect", () => { conn.destroy(); resolve(); });
      conn.on("error", reject);
      setTimeout(() => reject(new Error(`${name} tunnel timed out`)), 5000);
    });
  }
  assert(true, "both -L tunnels connect end to end");

  // ── re-running with no names is a no-op refresh, not a wipe ──
  const third = await sshUp("localhost", { ...opts });
  assert(third.names.sort().join(",") === "alpha,beta", "a bare re-run preserves the imported set");

  // ── teardown is per host ──
  const down = (await sshDown("alpha", opts)).torn;
  assert(down.length === 1, "naming one forward tears down its whole host Link");
  assert(!fs.existsSync(path.join(localDir, "alpha.sock")), "alpha landing removed");
  assert(!fs.existsSync(path.join(localDir, "alpha.json")), "its import marker removed with it");
  assert(!fs.existsSync(path.join(localDir, "beta.sock")), "beta landing removed with it");
  assert(!fs.existsSync(path.join(localDir, ".link.localhost.json")), "ledger removed");
  assert(listLinks(opts).length === 0, "no Links left");

  // The reverse marker on the remote belonged to this pi, so it is gone too —
  // a clean exit must not leave the other machine believing a dead Link lives.
  assert(!fs.existsSync(path.join(remoteDir, "mac-xfer.json")), "remote reverse marker removed on teardown");

  console.log("\nALL PASS");
} finally {
  fs.rmSync(path.join(os.homedir(), ".pi/xfer-ssh-env"), { force: true });
  for (const s of servers) s.close();
  await sshDown(undefined, opts);
  console.log(`(artifacts left at ${base} for inspection)`);
}
