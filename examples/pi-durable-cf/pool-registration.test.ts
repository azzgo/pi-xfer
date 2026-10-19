import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nodeConfig, SERVERLESS_BASE_PATH } from "./src/node-config.ts";
import { ensurePoolRegistered, poolRegistration, SERVERLESS_POOL_TIMING } from "./src/pool-config.ts";

const config = nodeConfig({
  AGENT: {} as never,
  WORKER_PUBLIC_URL: "https://worker.example.com",
  MESH_ENDPOINT: "https://engine.example.com",
  MESH_NAMESPACE: "default",
  MESH_TOKEN: "tok",
});

interface Canned {
  ok?: boolean;
  status?: number;
  json?: unknown;
}

function stubFetch(canned: Canned[]) {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const next = canned.shift();
    if (!next) throw new Error(`unexpected fetch: ${String(url)}`);
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const status = next.status ?? 200;
    return new Response(JSON.stringify(next.json ?? {}), { status });
  }) as typeof fetch;
  return { fetcher, calls };
}

const registration = poolRegistration(config);
const storedBody = {
  url: registration.url,
  headers: { "x-rivet-token": "tok" },
  request_lifespan: SERVERLESS_POOL_TIMING.requestLifespan,
  drain_grace_period: SERVERLESS_POOL_TIMING.drainGracePeriod,
};

describe("pi-durable-cf example: the pool record the Worker writes", () => {
  it("carries a grace period strictly below the lifespan, both in seconds", () => {
    assert.ok(
      SERVERLESS_POOL_TIMING.drainGracePeriod < SERVERLESS_POOL_TIMING.requestLifespan,
      "the engine refuses a grace period that is not less than the lifespan",
    );
    assert.equal(storedBody.request_lifespan, 30000, "seconds, not milliseconds");
    assert.ok("drain_grace_period" in storedBody, "omitted falls back to the engine's 1800 s default and is refused");
    assert.ok((storedBody.drain_grace_period as number) < 1800);
  });

  it("points the pool at the Worker's base path, and at nothing else", () => {
    assert.equal(registration.url, `https://worker.example.com${SERVERLESS_BASE_PATH}`);
    assert.ok(registration.url.startsWith(config.workerUrl), "the engine must never be given its own address");
  });

  it("is the one spelling both writers use: RivetKit's configurePool and the runner-config", () => {
    assert.deepEqual(Object.keys(registration).sort(), ["drainGracePeriod", "name", "requestLifespan", "url"]);
    assert.equal(registration.name, "cloudflare");
    assert.equal(registration.requestLifespan, SERVERLESS_POOL_TIMING.requestLifespan);
  });
});

describe("pi-durable-cf example: making the engine hold this pool", () => {
  it("writes nothing when the engine already holds exactly this record", async () => {
    const { fetcher, calls } = stubFetch([{ json: { datacenters: { default: { serverless: storedBody } } } }]);
    assert.equal(await ensurePoolRegistered(config, fetcher), "already correct");
    assert.equal(calls.length, 1, "a warm pool costs one GET per isolate, not a write on every /start");
    assert.equal(calls[0].method, "GET");
    assert.match(calls[0].url, /runner-configs\/cloudflare\?namespace=default$/);
  });

  it("re-registers when the stored record drifted, even by one field", async () => {
    for (const drift of [
      { ...storedBody, url: "https://elsewhere/api/rivet" },
      { ...storedBody, drain_grace_period: 1800 },
      { ...storedBody, request_lifespan: 30 },
      { headers: {} },
    ]) {
      const { fetcher, calls } = stubFetch([
        { json: { datacenters: { default: { serverless: drift } } } },
        { json: { datacenters: [{ name: "default" }] } },
        {},
      ]);
      assert.equal(await ensurePoolRegistered(config, fetcher), "wrote", `${JSON.stringify(drift)} must not pass as correct`);
      assert.equal(calls.length, 3);
    }
  });

  it("re-registers when any one datacenter drifted — a half-correct record is not correct", async () => {
    const { fetcher, calls } = stubFetch([
      { json: { datacenters: { default: { serverless: storedBody }, second: { serverless: { ...storedBody, request_lifespan: 30 } } } } },
      { json: { datacenters: [{ name: "default" }, { name: "second" }] } },
      {},
    ]);
    assert.equal(await ensurePoolRegistered(config, fetcher), "wrote");
    assert.equal(calls.length, 3);
  });

  it("writes the same serverless object to every datacenter the engine reports", async () => {
    const { fetcher, calls } = stubFetch([
      { status: 404 },
      { json: { datacenters: [{ name: "default" }, { name: "second" }] } },
      {},
    ]);
    await ensurePoolRegistered(config, fetcher);
    const written = calls[2].body as { datacenters: Record<string, { serverless: Record<string, unknown>; metadata: unknown }> };
    assert.deepEqual(Object.keys(written.datacenters), ["default", "second"]);
    assert.deepEqual(written.datacenters.default.serverless, written.datacenters.second.serverless);
    assert.deepEqual(written.datacenters.default.metadata, {});
  });

  it("never retries: a refused body is refused the same way every time, and a retry only spends subrequests", async () => {
    const { fetcher, calls } = stubFetch([
      { json: {} },
      { json: { datacenters: [{ name: "default" }] } },
      { status: 400 },
    ]);
    await assert.rejects(() => ensurePoolRegistered(config, fetcher), /PUT \/runner-configs 400/);
    assert.equal(calls.length, 3, "exactly one attempt; the 41-attempt retry storm is the bug this shape prevents");
  });

  it("reports which datacenter listing failed instead of writing a partial pool", async () => {
    const { fetcher, calls } = stubFetch([{ json: {} }, { status: 503 }]);
    await assert.rejects(() => ensurePoolRegistered(config, fetcher), /GET \/datacenters 503/);
    assert.equal(calls.length, 2);
  });

  it("refuses to register a pool with nowhere to register", async () => {
    await assert.rejects(() => ensurePoolRegistered({ ...config, endpoint: undefined }), /no engine endpoint/);
  });
});
