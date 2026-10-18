/**
 * The parts of the Worker that are pure data: the serverless pool body it writes
 * and the comparison that decides whether to write at all. A live run found that
 * a unit slip here is rejected by the engine as an *illegal config* rather than
 * as a mistake, and that retrying the rejection floods the invocation's
 * subrequest budget — so the shape is pinned here instead of only in prose.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  poolRegistrationBody,
  poolRegistrationMatches,
  poolServerlessBody,
  SERVERLESS_POOL_TIMING,
  timingIsLegal,
} from "./src/pool-config.ts";

const BASE_PATH = "/api/rivet";
const env = { WORKER_PUBLIC_URL: "https://worker.example.com", MESH_TOKEN: "tok" };
const body = () => poolServerlessBody(env, BASE_PATH);

describe("pi-durable-cf example: the pool registration the Worker writes", () => {
  it("carries a grace period strictly below the lifespan, both in seconds", () => {
    const serverless = body();
    assert.ok(
      SERVERLESS_POOL_TIMING.drainGracePeriod < SERVERLESS_POOL_TIMING.requestLifespan,
      "the engine refuses a grace period that is not less than the lifespan",
    );
    assert.equal(serverless.request_lifespan, SERVERLESS_POOL_TIMING.requestLifespan);
    assert.equal(serverless.drain_grace_period, SERVERLESS_POOL_TIMING.drainGracePeriod);
    assert.equal(timingIsLegal(SERVERLESS_POOL_TIMING), true);
  });

  it("states the grace period explicitly, because the engine's default 1800 s is larger", () => {
    assert.ok("drain_grace_period" in body(), "an omitted grace period falls back to 1800 s and is rejected");
    assert.ok((body().drain_grace_period as number) < 1800);
  });

  it("sends the lifespan in seconds, not milliseconds", () => {
    assert.equal(body().request_lifespan, 30000);
  });

  it("points the pool at the Worker, never at an engine", () => {
    assert.equal(body().url, "https://worker.example.com/api/rivet");
  });

  it("rejects a timing pair the engine would refuse", () => {
    assert.equal(timingIsLegal({ requestLifespan: 30, drainGracePeriod: 1800 }), false);
    assert.equal(timingIsLegal({ requestLifespan: 300, drainGracePeriod: 300 }), false, "strictly less, not equal");
    assert.equal(timingIsLegal({ requestLifespan: 0, drainGracePeriod: 0 }), false);
    assert.equal(timingIsLegal({ requestLifespan: Number.NaN, drainGracePeriod: 10 }), false);
  });

  it("writes the same serverless object for every datacenter", () => {
    const serverless = body();
    const written = poolRegistrationBody(serverless, ["default", "second"]) as {
      datacenters: Record<string, { serverless: unknown }>;
    };
    assert.deepEqual(Object.keys(written.datacenters), ["default", "second"]);
    assert.equal(written.datacenters.default.serverless, serverless);
    assert.equal(written.datacenters.second.serverless, serverless);
  });

  it("matches only a config identical to it, datacenter by datacenter", () => {
    const serverless = body();
    const stored = { datacenters: { default: { serverless } } };
    assert.equal(poolRegistrationMatches(stored, serverless, ["default"]), true);
    assert.equal(poolRegistrationMatches(stored, serverless, []), true, "no names means: accept what is there");
  });

  it("treats a missing, extra or drifted datacenter as a mismatch", () => {
    const serverless = body();
    assert.equal(poolRegistrationMatches({ datacenters: { default: { serverless } } }, serverless, ["default", "other"]), false);
    assert.equal(poolRegistrationMatches({ datacenters: {} }, serverless, ["default"]), false);
    assert.equal(poolRegistrationMatches(null, serverless, []), false);
    assert.equal(
      poolRegistrationMatches(
        { datacenters: { default: { serverless: { ...serverless, url: "https://elsewhere/api/rivet" } } } },
        serverless,
        [],
      ),
      false,
    );
    assert.equal(
      poolRegistrationMatches(
        { datacenters: { default: { serverless: { ...serverless, drain_grace_period: 1800 } } } },
        serverless,
        [],
      ),
      false,
      "the config that caused the retry storm is a mismatch, not a match",
    );
    assert.equal(
      poolRegistrationMatches(
        { datacenters: { default: { serverless } , second: { serverless: { ...serverless, request_lifespan: 30 } } } },
        serverless,
        [],
      ),
      false,
      "a half-correct config is still re-registered",
    );
  });
});
