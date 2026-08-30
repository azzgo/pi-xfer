import * as fs from "node:fs";
import * as net from "node:net";
import { MAX_FRAME_BYTES } from "./constants.js";
import type { XferNotifyMessage } from "./types.js";

/** Routes an incoming handoff into the user's session (ack is sent after). */
export interface InboundDelivery {
  deliver(msg: XferNotifyMessage): void;
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
          delivery.deliver(msg as XferNotifyMessage);
          socket.write(JSON.stringify({ type: "ack", msg_id: msg.msg_id }) + "\n");
        }
      }
    });
  });
}

/** Where a listener binds: a unix socket path or a TCP host/port pair. */
export type ListenEndpoint =
  | { kind: "unix"; path: string }
  | { kind: "tcp"; host: string; port: number };

/** Bind a server to its endpoint and report readiness (unix sockets are chmod'd 0600; TCP is not). */
export async function listenServer(opts: {
  server: net.Server;
  endpoint: ListenEndpoint;
  name: string;
  notifyError: (message: string) => void;
  setStatus: (text: string) => void;
  onListening: () => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const { server, endpoint } = opts;
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
      if (endpoint.kind === "unix") {
        try { fs.chmodSync(endpoint.path, 0o600); } catch { /* best effort */ }
      }
      opts.onListening();
      try { opts.setStatus(`📡 ${opts.name}`); } catch { /* best effort */ }
      resolve();
    };
    server.on("error", onRuntimeError);
    server.once("error", onError);
    server.once("listening", onListening);
    if (endpoint.kind === "unix") server.listen(endpoint.path);
    else server.listen({ host: endpoint.host, port: endpoint.port });
  });
}
