import * as fs from "node:fs";
import * as net from "node:net";
import { ACK_TIMEOUT_MS, CONNECT_TIMEOUT_MS, MAX_FRAME_BYTES } from "./constants.js";
import { endpointForName } from "./utils.js";

/** JSON-lines payload with a `msg_id` used to match the ack. */
export interface XferOutboundMessage {
  msg_id: string;
  [key: string]: unknown;
}

/** Connect to target socket, send, wait matching ack, close. */
export function sendNotify(target: string, msg: XferOutboundMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    const endpoint = endpointForName(target);
    if (!fs.existsSync(endpoint)) {
      reject(new Error(`peer "${target}" not found`));
      return;
    }

    const sock = net.createConnection(endpoint);
    let buffer = "";
    let settled = false;
    let ackTimer: NodeJS.Timeout | null = null;
    const connectTimer = setTimeout(() => {
      finish(new Error("connect timeout"));
    }, CONNECT_TIMEOUT_MS);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      if (ackTimer) clearTimeout(ackTimer);
      if (error) {
        sock.destroy();
        reject(error);
      } else {
        sock.end();
        resolve();
      }
    };

    sock.on("connect", () => {
      clearTimeout(connectTimer);
      try {
        sock.write(JSON.stringify(msg) + "\n");
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      ackTimer = setTimeout(() => finish(new Error("ack timeout")), ACK_TIMEOUT_MS);
    });

    sock.on("data", (chunk) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer, "utf-8") > MAX_FRAME_BYTES) {
        finish(new Error("ack frame too large"));
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;

        let response: unknown;
        try { response = JSON.parse(line); } catch {
          finish(new Error("invalid ack"));
          return;
        }
        if (!response || typeof response !== "object" || Array.isArray(response)) {
          finish(new Error("invalid ack"));
          return;
        }
        const ack = response as { type?: unknown; msg_id?: unknown };
        if (ack.type === "ack" && ack.msg_id === msg.msg_id) {
          finish();
          return;
        }
      }
    });

    sock.on("error", (error) => finish(error));
    sock.on("close", () => {
      if (!settled) finish(new Error("peer closed before ack"));
    });
  });
}
