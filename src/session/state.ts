import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { METADATA_POLL_MS } from "../core/constants.ts";
import type { Identity } from "../core/types.ts";

/** Runtime identity + status for this agent; owns the `<name>.json` metadata file. */
export class XferState {
  identity: Identity | null = null;
  runtimeContext: ExtensionContext | null = null;
  currentModel = "unknown";
  currentStatus = "idle";
  description?: string;
  private metadataPollTimer: NodeJS.Timeout | null = null;
  private lastMetadata = "";

  /** Session display name, if the session manager has one. */
  sessionName(): string | undefined {
    try {
      const name = this.runtimeContext?.sessionManager.getSessionName();
      return name?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** Force the next `writeMetadata()` to write even if content is unchanged. */
  markDirty(): void {
    this.lastMetadata = "";
  }

  writeMetadata(force = false): void {
    if (!this.identity || !this.runtimeContext) return;
    const metadata = {
      xferName: this.identity.name,
      sessionName: this.sessionName(),
      cwd: this.identity.cwd,
      model: this.currentModel,
      status: this.currentStatus,
      pid: process.pid,
      startedAt: this.identity.startedAt,
      ...(this.description ? { description: this.description } : {}),
    };
    const serialized = `${JSON.stringify(metadata, null, 2)}\n`;
    if (!force && serialized === this.lastMetadata) return;
    const temp = `${this.identity.metadata}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(temp, serialized, { encoding: "utf-8", mode: 0o600 });
      fs.renameSync(temp, this.identity.metadata);
      try { fs.chmodSync(this.identity.metadata, 0o600); } catch { /* best effort */ }
      this.lastMetadata = serialized;
    } catch {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
    }
  }

  startMetadataPolling(): void {
    if (this.metadataPollTimer) clearInterval(this.metadataPollTimer);
    this.metadataPollTimer = setInterval(() => this.writeMetadata(), METADATA_POLL_MS);
    this.metadataPollTimer.unref?.();
  }

  stopMetadataPolling(): void {
    if (!this.metadataPollTimer) return;
    clearInterval(this.metadataPollTimer);
    this.metadataPollTimer = null;
  }

  setStatus(status: string): void {
    this.currentStatus = status;
    this.writeMetadata();
  }

  /**
   * Whether a Handoff arriving now would be injected into an idle turn or steered
   * into the running one. `isIdle()` alone reads a queued-but-not-started message as
   * free, and then `deliverAs: "followUp"` parks the Handoff behind work that was
   * already waiting — which would make a reported `delivered` false.
   */
  isRuntimeIdle(): boolean {
    if (!this.runtimeContext) return true;
    try {
      const ctx = this.runtimeContext;
      return ctx.isIdle() && !ctx.hasPendingMessages();
    } catch {
      return true;
    }
  }
}
