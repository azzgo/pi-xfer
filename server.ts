import * as fs from "node:fs";
import * as net from "node:net";
import { MAX_FRAME_BYTES } from "./constants.ts";
import type { XferNotifyMessage } from "./types.ts";

/** Routes an incoming handoff into the user's session (ack is sent after). */
export interface InboundDelivery {
  deliver(msg: XferNotifyMessage): void;
  /**
   * What the delivery learned about the payload's integrity, when the frame
   * carried a sender-side hash: `mismatch` means the bytes that arrived are not
   * the bytes that were sent. Reported in the ack so the SENDER learns it —
   * a receiver-only verdict would leave the sender believing `delivered` meant
   * "intact", which is exactly the ambiguity ADR-0020 removed elsewhere.
   *
   * `verified` is narrower than it sounds: it says the frame's body reached
   * this process unchanged, not that the text was never rewritten upstream.
   * See XferNotifyMessage.docSha256 for the boundary.
   */
  integrity?(): "verified" | "mismatch" | undefined;
}

/** Inbound socket server: parses JSON-lines frames, delegates `xfer-notify`, acks. */
export function createServer(delivery: InboundDelivery): net.Server {
  return net.createServer((socket) => {
    let buf = "";
    socket.on("error", () => { /* peer may disconnect after delivery */ });
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      if (Buffer.byteLength(buf, "utf-8") > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line.trim()) continue;

        let msg: any;
        try { msg = JSON.parse(line); } catch {
          socket.destroy();
          return;
        }

        // only handle xfer-notify (one-way handoff)
        if (msg.type === "xfer-notify" && typeof msg.msg_id === "string") {
          // The ack is written only after `deliver` returns, so the ordering already
          // carries the claim: if delivery throws, no ack goes out and the sender's ack
          // timeout resolves to `unknown`. The claim is "handed to this session", never
          // "read" — `pi.sendMessage` returns void (ADR-0020).
          delivery.deliver(msg as XferNotifyMessage);
          const integrity = delivery.integrity?.();
          socket.write(
            JSON.stringify({
              type: "ack",
              msg_id: msg.msg_id,
              outcome: integrity === "mismatch" ? "corrupt" : "delivered",
              ...(integrity ? { integrity } : {}),
            }) + "\n",
          );
        }
      }
    });
  });
}

/** Bind a server to its unix socket path, chmod 0600, and report readiness. */
export async function listenServer(opts: {
  server: net.Server;
  path: string;
  name: string;
  notifyError: (message: string) => void;
  setStatus: (text: string) => void;
  onListening: () => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const { server } = opts;
    const onRuntimeError = (error: Error) => {
      if (!server.listening) return;
      try { opts.notifyError(`❌ Xfer listener error: ${error.message}`); } catch { /* session may be shutting down */ }
    };
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      try { fs.chmodSync(opts.path, 0o600); } catch { /* best effort */ }
      opts.onListening();
      try { opts.setStatus(`📡 ${opts.name}`); } catch { /* best effort */ }
      resolve();
    };
    server.on("error", onRuntimeError);
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(opts.path);
  });
}
