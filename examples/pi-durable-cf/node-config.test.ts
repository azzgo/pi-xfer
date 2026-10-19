import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_NODE_NAME, DEFAULT_POOL_NAME, nodeConfig, SERVERLESS_BASE_PATH, type Env } from "./src/node-config.ts";
import { poolRegistration, runnerConfigBody, SERVERLESS_POOL_TIMING } from "./src/pool-config.ts";

const base = {
  AGENT: {} as never,
  AGENT_STORAGE: {} as never,
  WORKER_PUBLIC_URL: "https://worker.example.com",
};
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

  it("takes the Worker's URL from the request when no var is set, so a vanilla deploy works", () => {
    const env = { AGENT: {} as never, AGENT_STORAGE: {} as never } as Env;
    assert.equal(nodeConfig(env, "https://worker.example.com/health").workerUrl, "https://worker.example.com");
    assert.throws(() => nodeConfig(env), /WORKER_PUBLIC_URL is unset/);
  });

  it("carries no trailing slash on the Worker's own URL, so a path can be appended to it", () => {
    assert.equal(config({ WORKER_PUBLIC_URL: "https://worker.example.com/" }).workerUrl, "https://worker.example.com");
    assert.equal(config().workerUrl, "https://worker.example.com");
  });

  it("reports no engine endpoint rather than inventing one", () => {
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

describe("pi-durable-cf example: the pool record", () => {
  const registration = poolRegistration(config());

  it("carries a grace period strictly below the lifespan, both in seconds", () => {
    assert.ok(
      SERVERLESS_POOL_TIMING.drainGracePeriod < SERVERLESS_POOL_TIMING.requestLifespan,
      "the engine refuses a grace period that is not less than the lifespan",
    );
    assert.equal(SERVERLESS_POOL_TIMING.requestLifespan, 30000, "seconds, not milliseconds");
  });

  it("points the pool at the Worker's base path, and at nothing else", () => {
    assert.equal(registration.url, `https://worker.example.com${SERVERLESS_BASE_PATH}`);
    assert.ok(registration.url.startsWith(config().workerUrl), "the engine must never be given its own address");
  });

  it("is the one record both writers spell: RivetKit's configurePool and the out-of-band runner-config", () => {
    assert.deepEqual(Object.keys(registration).sort(), ["drainGracePeriod", "name", "requestLifespan", "url"]);
    assert.equal(registration.name, "cloudflare");
    assert.deepEqual(runnerConfigBody(registration, "tok", ["default"]), {
      datacenters: {
        default: {
          serverless: {
            url: "https://worker.example.com/api/rivet",
            headers: { "x-rivet-token": "tok" },
            request_lifespan: SERVERLESS_POOL_TIMING.requestLifespan,
            drain_grace_period: SERVERLESS_POOL_TIMING.drainGracePeriod,
          },
          metadata: {},
        },
      },
    });
  });
});
