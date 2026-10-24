/**
 * endpoint-claim.test.ts — one rule, three outcomes: a live peer is never stolen, a crash
 * leftover is cleared, and a name nobody is using is free.
 *
 * Hermetic: a fresh `os.tmpdir()` directory per test, real unix sockets, no pi, no engine.
 * This is the test that would have caught the unlink-before-bind takeover.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { claimEndpoint, nameIsLive, NameTakenError } from "./endpoint-claim.ts";
import { endpointForName, metadataForName } from "../core/utils.ts";

let dir: string;
const servers: net.Server[] = [];

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-claim-test-")); });
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A listener on `<name>.sock`, as a live peer would have. */
function listen(name: string): Promise<void> {
  const server = net.createServer(() => { /* accept and ignore */ });
  servers.push(server);
  return new Promise((resolve) => server.listen(endpointForName(name, dir), resolve));
}

/** Metadata holding `pid`, as this process would write it. */
function writeMetadata(name: string, pid: number): void {
  fs.writeFileSync(metadataForName(name, dir), JSON.stringify({ xferName: name, pid }), "utf-8");
}

const alivePid = process.pid;
const deadPid = 2 ** 22 + 12345;

describe("nameIsLive: is somebody already answering to this name", () => {
  it("is false when nothing exists", async () => {
    assert.equal(await nameIsLive("ghost", dir), false);
  });

  it("is true when the recorded pid is alive, even with no socket", async () => {
    writeMetadata("alpha", alivePid);
    assert.equal(await nameIsLive("alpha", dir), true);
  });

  it("is true when something accepts on the socket, even with no metadata", async () => {
    await listen("bravo");
    assert.equal(await nameIsLive("bravo", dir), true);
  });

  it("is false for a dead pid with a socket nobody accepts on", async () => {
    writeMetadata("charlie", deadPid);
    fs.writeFileSync(endpointForName("charlie", dir), "");
    assert.equal(await nameIsLive("charlie", dir), false);
  });
});

describe("claimEndpoint: free the name or refuse", () => {
  it("clears a crash leftover, then the name binds", async () => {
    writeMetadata("delta", deadPid);
    fs.writeFileSync(endpointForName("delta", dir), "");
    await claimEndpoint("delta", dir);
    assert.equal(fs.existsSync(endpointForName("delta", dir)), false);
    assert.equal(fs.existsSync(metadataForName("delta", dir)), false);
    await listen("delta");
    assert.equal(await nameIsLive("delta", dir), true);
  });

  it("refuses a name a live peer owns, and leaves its files alone", async () => {
    await listen("echo");
    writeMetadata("echo", alivePid);
    await assert.rejects(claimEndpoint("echo", dir), NameTakenError);
    assert.equal(fs.existsSync(endpointForName("echo", dir)), true, "the live socket survives");
    assert.equal(fs.existsSync(metadataForName("echo", dir)), true, "the live metadata survives");
  });

  it("names the conflicting peer in the error", async () => {
    await listen("foxtrot");
    await assert.rejects(claimEndpoint("foxtrot", dir), (error: Error) => {
      assert.match(error.message, /"foxtrot" is already in use by a live xfer peer/);
      assert.equal((error as NameTakenError).peerName, "foxtrot");
      return true;
    });
  });

  it("claims a free name", async () => {
    await claimEndpoint("golf", dir);
    await listen("golf");
    assert.equal(await nameIsLive("golf", dir), true);
  });
});
