import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_NODE_NAME, DEFAULT_POOL_NAME, nodeConfig, type Env } from "./src/node-config.ts";

const base = { AGENT: {} as never, WORKER_PUBLIC_URL: "https://worker.example.com" };
const config = (env: Partial<Env> = {}) => nodeConfig({ ...base, ...env } as Env);

describe("pi-durable-cf example: what this node is configured as", () => {
  it("names the node cf-node and joins the cloudflare pool unless told otherwise", () => {
    assert.equal(config().nodeName, DEFAULT_NODE_NAME);
    assert.equal(config().pool, DEFAULT_POOL_NAME);
    assert.equal(config({ NODE_NAME: "edge-1" }).nodeName, "edge-1");
    assert.equal(config({ POOL_NAME: "edge" }).pool, "edge");
  });

  it("falls back to RivetKit's own env vars when the mesh secrets are unset", () => {
    const rivet = config({ RIVET_ENDPOINT: "https://rivet.example.com", RIVET_NAMESPACE: "ns" });
    assert.equal(rivet.endpoint, "https://rivet.example.com");
    assert.equal(rivet.namespace, "ns");
    const mesh = config({ MESH_ENDPOINT: "https://mesh.example.com", MESH_NAMESPACE: "mesh-ns" });
    assert.equal(mesh.endpoint, "https://mesh.example.com", "the mesh secret wins where both are set");
    assert.equal(mesh.namespace, "mesh-ns");
  });

  it("carries no trailing slash on the Worker's own URL, so a path can be appended to it", () => {
    assert.equal(config({ WORKER_PUBLIC_URL: "https://worker.example.com/" }).workerUrl, "https://worker.example.com");
    assert.equal(config().workerUrl, "https://worker.example.com");
  });

  it("reports no engine endpoint rather than inventing one, and the pool cannot register without it", () => {
    assert.equal(config().endpoint, undefined);
    assert.equal(config().token, undefined);
  });

  it("passes the model credentials through untouched, absent by default", () => {
    assert.deepEqual(config().model, { apiKey: undefined, model: undefined });
    assert.deepEqual(config({ DEEPSEEK_API_KEY: "sk-x", DEEPSEEK_MODEL: "deepseek-chat" }).model, {
      apiKey: "sk-x",
      model: "deepseek-chat",
    });
  });
});
