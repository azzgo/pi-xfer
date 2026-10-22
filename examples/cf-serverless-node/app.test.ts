import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "./src/app.ts";
import type { MeshHandoffMessage } from "./src/mesh-actor.ts";
import type { Env } from "./src/node-config.ts";
import type { ReplyClient } from "./src/reply-client.ts";

function memoryStorage() {
  const store = new Map<string, unknown>();
  return {
    async get(key: string) {
      return store.get(key);
    },
    async put(key: string, value: unknown) {
      store.set(key, value);
    },
  };
}

const handoff: MeshHandoffMessage = {
  id: "mvbsq4ja-5dnpgd",
  from: "laptop",
  to: "cf-node",
  summary: "check the mesh round trip",
  document: "# hello from the other side",
};

interface Harness {
  request(path: string, init?: RequestInit): Promise<Response>;
  sent: Array<{ target: string; id: string; from: string; summary: string; document: string }>;
  meshCalls: string[];
}

function harness(overrides: Partial<Env> = {}, mesh = async () => new Response("mesh", { status: 200 })): Harness {
  const sent: Harness["sent"] = [];
  const meshCalls: string[] = [];
  const replyClient = (): ReplyClient => ({
    send: async (target, message) => {
      sent.push({ target, ...message });
    },
  });
  const env = {
    AGENT_STORAGE: memoryStorage(),
    WORKER_PUBLIC_URL: "https://worker.example.com",
    MESH_ENDPOINT: "https://engine.example.com",
    ...overrides,
  } as unknown as Env;
  const app = createApp({
    mesh: (request) => {
      meshCalls.push(new URL(request.url).pathname);
      return mesh();
    },
    replyClient,
  });
  return {
    request: (path, init) => app.fetch(new Request(`https://worker.example.com${path}`, init), env),
    sent,
    meshCalls,
  };
}

describe("cf-serverless-node example: the Worker's routes", () => {
  it("answers /health without touching the mesh engine", async () => {
    const h = harness();
    const response = await h.request("/health");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, node: "cf-node", engine: true });
    assert.deepEqual(h.meshCalls, [], "a health check must not build a registry");
  });

  it("says where it lives at /, so a cold deploy can be inspected with curl", async () => {
    const h = harness();
    assert.deepEqual(await (await h.request("/")).json(), {
      node: "cf-node",
      mesh: "/api/rivet",
      routes: ["/health", "/agent/answer"],
    });
  });

  it("hands every other path to the mesh registry, which owns them itself", async () => {
    const h = harness();
    await h.request("/api/rivet/metadata");
    await h.request("/api/rivet/start", { method: "POST", body: "{}" });
    assert.deepEqual(h.meshCalls, ["/api/rivet/metadata", "/api/rivet/start"]);
  });

  it("answers a handoff once, pairs the ids, and sends the reply to the sender", async () => {
    const h = harness();
    const response = await h.request("/agent/answer", { method: "POST", body: JSON.stringify(handoff) });
    assert.equal(response.status, 200);
    const answer = (await response.json()) as { replyId: string; document: string };
    assert.equal(answer.replyId, `${handoff.id}-echo`);
    assert.match(answer.document, /In reply to.*mvbsq4ja-5dnpgd/);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].target, "laptop", "the answer goes back to the sender");
    assert.equal(h.sent[0].from, "cf-node");
    assert.equal(h.sent[0].id, answer.replyId);
  });

  it("answers a redelivered handoff with the id it produced the first time, and sends once", async () => {
    const h = harness();
    const first = (await (await h.request("/agent/answer", { method: "POST", body: JSON.stringify(handoff) })).json()) as {
      replyId: string;
      document: string;
    };
    const second = (await (await h.request("/agent/answer", { method: "POST", body: JSON.stringify(handoff) })).json()) as {
      replyId: string;
      document: string;
    };
    assert.equal(second.replyId, first.replyId);
    assert.match(second.document, /Already answered/);
    assert.equal(h.sent.length, 1, "the sender must not be told twice");
  });
});
