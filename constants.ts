import * as os from "node:os";
import * as path from "node:path";

/** Root directory for xfer peer sockets + peer metadata. */
export const XFER_DIR = path.join(os.homedir(), "pi-handoff", "agents");

export const CONNECT_TIMEOUT_MS = 5_000;
export const ACK_TIMEOUT_MS = 5_000;
export const METADATA_POLL_MS = 1_000;
export const MAX_FRAME_BYTES = 1024 * 1024;
