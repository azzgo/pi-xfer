import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentDurableObject, echoDocument, replyIdFor, type AgentStorage } from "./src/agent-do.ts";
import type { MeshHandoffMessage } from "./src/mesh-actor.ts";

function memoryStorage(): AgentStorage {
  const store = new Map<string, unknown>();
  return {
    async get(key) { return store.get(key); },
    async put(key, value) { store.set(key, value); },
    async list(prefix) {
      return new Map([...store].filter(([key]) => key.startsWith(prefix)));
    },
  };
}

function makeAgent(sent: Array<{ target: string; document: string; replyId: string }>, env = {}) {
  return {
    sent,
    agent: new AgentDurableObject({ storage: memoryStorage() }, async (target, reply) => {
      sent.push({ target, document: reply.document, replyId: reply.replyId });
    }, env),
  };
}

const handoff: MeshHandoffMessage = {
  id: "mvbsq4ja-5dnpgd",
  from: "laptop",
  to: "cf-node",
  summary: "check the mesh round trip",
  document: "# hello from the other side",
};

describe("pi-durable-cf example: the Durable Object's answer", () => {
  it("echoes without any credential, pairing the answer to the original id", async () => {
    const { agent: doAgent, sent } = makeAgent([]);
    const reply = await doAgent.receive(handoff);
    assert.equal(reply.inReplyTo, handoff.id);
    assert.equal(reply.replyId, replyIdFor(handoff.id));
    assert.match(reply.document, /In reply to.*mvbsq4ja-5dnpgd/);
    assert.match(reply.document, /no model was called/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].target, "laptop", "the answer goes back to the sender");
  });

  it("answers a redelivered handoff once, not twice", async () => {
    const sent: Array<{ target: string; document: string; replyId: string }> = [];
    const doAgent = new AgentDurableObject({ storage: memoryStorage() }, async (target, reply) => {
      sent.push({ target, document: reply.document, replyId: reply.replyId });
    }, {});
    await doAgent.receive(handoff);
    const second = await doAgent.receive(handoff);
    assert.equal(sent.length, 1, "the sender never sees two answers to one handoff");
    assert.equal(second.replyId, replyIdFor(handoff.id));
    assert.match(second.document, /Already answered/);
  });

  it("keeps the original id out of the reply id, so neither is mistaken for the other", async () => {
    const { agent: doAgent } = makeAgent([]);
    const reply = await doAgent.receive(handoff);
    assert.notEqual(reply.replyId, handoff.id);
    assert.ok(reply.replyId.includes(handoff.id), "the pairing stays readable in the id itself");
  });

  it("falls back to the echo when the model is configured but unreachable", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("upstream down", { status: 503 })) as typeof fetch;
    try {
      const { agent: doAgent } = makeAgent([], { DEEPSEEK_API_KEY: "sk-test" });
      const reply = await doAgent.receive(handoff);
      assert.match(reply.document, /DeepSeek branch was configured but did not answer/);
      assert.match(reply.document, /deepseek 503/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("uses the model answer when one comes back", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: "model says hi" } }] })) as typeof fetch;
    try {
      const { agent: doAgent } = makeAgent([], { DEEPSEEK_API_KEY: "sk-test" });
      assert.equal((await doAgent.receive(handoff)).document, "model says hi");
    } finally {
      globalThis.fetch = original;
    }
  });


  it("states the echo plainly when nothing is configured", () => {
    assert.match(echoDocument(handoff), /This is the fixed echo/);
    assert.match(echoDocument(handoff, "reason here"), /reason here/);
  });
});
