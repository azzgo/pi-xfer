import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import { METADATA_POLL_MS } from "./constants.js";
import type { Identity } from "./types.js";

/** Runtime identity + status for this agent; owns the `<name>.json` metadata file. */
export class XferState {
  identity: Identity | null = null;
  runtimeContext: ExtensionContext | null = null;
  currentModel = "unknown";
  currentStatus = "idle";

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

  isRuntimeIdle(): boolean {
    if (!this.runtimeContext) return true;
    try { return this.runtimeContext.isIdle(); } catch { return true; }
  }
}
