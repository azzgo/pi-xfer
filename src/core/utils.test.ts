/**
 * The socket file stem is the only thing standing between a peer name and a unix
 * socket bind that fails: `sun_path` is 108 bytes on Linux and 104 on macOS, and
 * `encodeURIComponent` triples every CJK byte. Everything here runs against a
 * fresh `mkdtemp` — the real `~/.pi/xfer` is never touched.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  MAX_ENCODED_STEM,
  encodeAgentName,
  endpointForName,
  listPeers,
  metadataForName,
  nameForStem,
  socketStem,
} from "./utils.ts";

/** A real name that overflows `sun_path` once percent-encoded. */
const LONG_CJK_NAME = "反派圣女大人是我的小号_x6ib";

/** `sun_path` leaves 104 bytes of room on macOS, the tighter of the two. */
const SUN_PATH_LIMIT = 104;

function withDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-utils-"));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("socketStem: short names keep the plain encoding", () => {
  it("returns encodeURIComponent for a name that fits", () => {
    assert.equal(socketStem("pi-xfer_dl5l"), encodeAgentName("pi-xfer_dl5l"));
    assert.equal(socketStem("正文_l0ns"), encodeAgentName("正文_l0ns"));
  });

  it("keeps a stem at the budget unhashed", () => {
    const name = "a".repeat(MAX_ENCODED_STEM);
    assert.equal(socketStem(name), name);
  });
});

describe("socketStem: a name that would overflow is hashed", () => {
  it("is deterministic and fixed-length", () => {
    assert.equal(socketStem(LONG_CJK_NAME), socketStem(LONG_CJK_NAME));
    assert.match(socketStem(LONG_CJK_NAME), /^\+[0-9a-f]{16}$/);
  });

  it("never collides across names, even ones that share a prefix", () => {
    const first = socketStem(LONG_CJK_NAME);
    const second = socketStem(`${LONG_CJK_NAME}-2`);
    assert.notEqual(first, second);
  });

  it("hashes one character past the budget, and keeps the last plain one", () => {
    assert.equal(socketStem("a".repeat(MAX_ENCODED_STEM + 1)).startsWith("+"), true);
  });

  it("keeps the endpoint inside sun_path for the name that broke the bind", () => {
    withDir((dir) => {
      const endpoint = endpointForName(LONG_CJK_NAME, dir);
      assert.ok(
        Buffer.byteLength(endpoint) <= SUN_PATH_LIMIT,
        `${endpoint} is ${Buffer.byteLength(endpoint)} bytes`,
      );
    });
  });

  it("puts the metadata sidecar beside the hashed socket, not the encoded name", () => {
    withDir((dir) => {
      assert.equal(
        path.basename(metadataForName(LONG_CJK_NAME, dir)),
        `${socketStem(LONG_CJK_NAME)}.json`,
      );
    });
  });
});

describe("nameForStem: the inverse mapping", () => {
  it("decodes an ordinary stem without touching the disk", () => {
    withDir((dir) => {
      assert.equal(nameForStem(socketStem("正文_l0ns"), dir), "正文_l0ns");
    });
  });

  it("recovers a hashed name from the xferName its metadata records", () => {
    withDir((dir) => {
      fs.writeFileSync(metadataForName(LONG_CJK_NAME, dir), JSON.stringify({ xferName: LONG_CJK_NAME }));
      assert.equal(nameForStem(socketStem(LONG_CJK_NAME), dir), LONG_CJK_NAME);
      assert.equal(endpointForName(nameForStem(socketStem(LONG_CJK_NAME), dir), dir), endpointForName(LONG_CJK_NAME, dir));
    });
  });

  it("leaves a hashed stem alone when its sidecar is gone", () => {
    withDir((dir) => {
      const stem = socketStem(LONG_CJK_NAME);
      assert.equal(nameForStem(stem, dir), stem);
    });
  });

  it("ignores an unreadable sidecar instead of throwing", () => {
    withDir((dir) => {
      const stem = socketStem(LONG_CJK_NAME);
      fs.writeFileSync(path.join(dir, `${stem}.json`), "{not json");
      assert.equal(nameForStem(stem, dir), stem);
    });
  });
});

describe("listPeers: a hashed peer is reported by its real name", () => {
  it("resolves the name and keeps the on-disk endpoint", () => {
    withDir((dir) => {
      const endpoint = endpointForName(LONG_CJK_NAME, dir);
      fs.writeFileSync(endpoint, "");
      fs.writeFileSync(metadataForName(LONG_CJK_NAME, dir), JSON.stringify({ xferName: LONG_CJK_NAME, cwd: "/srv/app" }));
      const peers = listPeers("me", dir);
      assert.deepEqual(
        peers.map((peer) => ({ xferName: peer.xferName, endpoint: peer.endpoint, cwd: peer.cwd })),
        [{ xferName: LONG_CJK_NAME, endpoint, cwd: "/srv/app" }],
      );
    });
  });

  it("still excludes this session's own name", () => {
    withDir((dir) => {
      fs.writeFileSync(endpointForName(LONG_CJK_NAME, dir), "");
      fs.writeFileSync(metadataForName(LONG_CJK_NAME, dir), JSON.stringify({ xferName: LONG_CJK_NAME }));
      assert.deepEqual(listPeers(LONG_CJK_NAME, dir), []);
    });
  });
});
