import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answerHandoff, echoDocument, type Model } from "./src/agent-do.ts";
import type { MeshHandoffMessage } from "./src/mesh-actor.ts";

const handoff: MeshHandoffMessage = {
  id: "mvbsq4ja-5dnpgd",
  from: "laptop",
  to: "cf-node",
  summary: "check the mesh round trip",
  document: "# hello from the other side",
};

async function withFetch<T>(replacement: typeof fetch, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

describe("cf-serverless-node example: what the agent answers", () => {
  it("echoes without any credential, naming the handoff it answers", async () => {
    const document = await answerHandoff(handoff, {} satisfies Model);
    assert.match(document, /In reply to.*mvbsq4ja-5dnpgd/);
    assert.match(document, /no model was called/);
  });

  it("says the echo is fixed when nothing is configured, and why when something failed", () => {
    assert.match(echoDocument(handoff), /This is the fixed echo/);
    assert.match(echoDocument(handoff, "reason here"), /reason here/);
  });

  it("falls back to the echo when the model is configured but unreachable", async () => {
    const document = await withFetch(
      (async () => new Response("upstream down", { status: 503 })) as typeof fetch,
      () => answerHandoff(handoff, { DEEPSEEK_API_KEY: "sk-test" }),
    );
    assert.match(document, /DeepSeek branch was configured but did not answer/);
    assert.match(document, /deepseek 503/);
  });

  it("uses the model answer when one comes back", async () => {
    const document = await withFetch(
      (async () => Response.json({ choices: [{ message: { content: "model says hi" } }] })) as typeof fetch,
      () => answerHandoff(handoff, { DEEPSEEK_API_KEY: "sk-test" }),
    );
    assert.equal(document, "model says hi");
  });
});
