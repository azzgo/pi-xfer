/**
 * Claiming a peer endpoint: the one place that decides whether a live peer already owns a
 * name, so binding never silently takes one over.
 *
 * The rule: releasing *our own* name is correct, clearing *someone else's* claim is the
 * bug. Both callers (`XferController.start`, `XferController.rename`'s new name, and the
 * adapter daemon) used to `unlink` unconditionally before `listen`, which made
 * `EADDRINUSE` — and the startup error that reports it — unreachable. Two same-named
 * sessions then both "bound" successfully: the first was stranded on an unlinked inode
 * that nobody could ever connect to again, both wrote the same `<name>.json`, and a sender
 * asking for that name reached whichever process bound last.
 *
 * The predicates are `gc.ts`'s, reused rather than re-derived: `processAlive` treats
 * `EPERM` as alive, and `socketHasListener` treats a connect timeout as listening. Both
 * err toward "someone is there", so a crash leftover is cleared and a live peer is never
 * stolen.
 */
import * as fs from "node:fs";
import { endpointForName, metadataForName, readPeerMetadata } from "./utils.ts";
import { processAlive, socketHasListener } from "./gc.ts";

/**
 * Whether a live peer currently owns `name`.
 *
 * A recorded pid that is still alive is conclusive. A socket nobody accepts connections on
 * is conclusive the other way. In between — a live listener with no readable metadata — the
 * listener wins, because stealing it is the failure this function exists to prevent.
 */
export async function nameIsLive(name: string, xferDir: string): Promise<boolean> {
  const pid = readPeerMetadata(name, xferDir).pid;
  if (typeof pid === "number" && processAlive(pid)) return true;
  const endpoint = endpointForName(name, xferDir);
  if (!fs.existsSync(endpoint)) return false;
  return socketHasListener(endpoint);
}

/** Raised when a name cannot be claimed because a live peer already answers to it. */
export class NameTakenError extends Error {
  /** The name that could not be claimed. */
  readonly peerName: string;
  constructor(peerName: string) {
    super(
      `the name "${peerName}" is already in use by a live xfer peer — stop that one, or pick ` +
        `another name with /xfer name <new> (adapter daemon: --name <new>)`,
    );
    this.name = "NameTakenError";
    this.peerName = peerName;
  }
}

/**
 * Free an endpoint + metadata pair for binding, or refuse.
 *
 * Leaves nothing behind on refusal, so the caller can surface the error without having
 * half-cleared a live peer's files.
 */
export async function claimEndpoint(name: string, xferDir: string): Promise<void> {
  const endpoint = endpointForName(name, xferDir);
  const metadata = metadataForName(name, xferDir);
  if (await nameIsLive(name, xferDir)) throw new NameTakenError(name);
  for (const file of [endpoint, metadata]) {
    try { fs.unlinkSync(file); } catch { /* absent is fine */ }
  }
}
