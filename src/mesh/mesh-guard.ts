/**
 * Structure, not discipline: the mesh's two outbound planes (`fetch` for the
 * engine REST API, `rivetkit/client` for the socket transport) are one funnel
 * each, and both refuse to leave the machine while a test run is in progress.
 *
 * "In a test run" is exactly what node sets up for `node --test` workers and
 * for any process a test spawns from one: `NODE_TEST_CONTEXT`. Nothing else
 * arms the guard — an installed extension, `/xfer mesh up`, the admin daemon
 * and the adapter daemon never see it, so real traffic is unaffected.
 *
 * The intentional escape hatch is `XFER_ALLOW_REMOTE=1`, which only a test that
 * is *deliberately* exercising the guard should set. It is never set by
 * `npm test`, and the guard counts every allowance it grants so a run can
 * assert the count is zero.
 */
import * as os from "node:os";
import * as path from "node:path";
import type { MeshConfig } from "./mesh-config.ts";

/** Thrown when test-context code tries to reach an endpoint that is not this machine. */
export class MeshRemoteBlockedError extends Error {
  readonly endpoint: string;
  constructor(endpoint: string, message: string) {
    super(message);
    this.name = "MeshRemoteBlockedError";
    this.endpoint = endpoint;
  }
}

const TEST_CONTEXT_ENV = "NODE_TEST_CONTEXT";
const ALLOW_REMOTE_ENV = "XFER_ALLOW_REMOTE";

/** Endpoints the guard lets through: this machine only, however it is spelled. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "host.docker.internal"]);

/** Every decision the guard made since this process started, for tests to assert on. */
export interface MeshGuardLedger {
  /** Endpoints allowed because the guard was not armed (normal runtime). */
  unguarded: number;
  /** Loopback endpoints allowed while armed (test fixtures). */
  loopback: number;
  /** Non-loopback endpoints allowed by an explicit `XFER_ALLOW_REMOTE=1`. */
  allowed: string[];
  /** Non-loopback attempts the guard refused. */
  blocked: string[];
}

const ledger: MeshGuardLedger = { unguarded: 0, loopback: 0, allowed: [], blocked: [] };

export function meshGuardLedger(): MeshGuardLedger {
  return { unguarded: ledger.unguarded, loopback: ledger.loopback, allowed: [...ledger.allowed], blocked: [...ledger.blocked] };
}

export function resetMeshGuardLedger(): void {
  ledger.unguarded = 0;
  ledger.loopback = 0;
  ledger.allowed.length = 0;
  ledger.blocked.length = 0;
}

/** True when this process is part of a `node --test` run (worker or anything it spawned). */
export function inTestContext(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[TEST_CONTEXT_ENV]);
}

/** True when the caller opted into remote traffic explicitly, for one process. */
export function remoteExplicitlyAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ALLOW_REMOTE_ENV] === "1";
}

/** Hostname of an endpoint, or `null` when it is not a parseable URL. */
export function endpointHost(endpoint: string): string | null {
  try {
    return new URL(endpoint).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isLoopbackEndpoint(endpoint: string): boolean {
  const host = endpointHost(endpoint);
  return host !== null && LOOPBACK_HOSTS.has(host);
}

/** The one place both planes ask "may this process talk to that endpoint?". */
export function assertEndpointReachable(endpoint: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!inTestContext(env)) {
    ledger.unguarded += 1;
    return;
  }
  if (isLoopbackEndpoint(endpoint)) {
    ledger.loopback += 1;
    return;
  }
  if (remoteExplicitlyAllowed(env)) {
    ledger.allowed.push(endpoint);
    return;
  }
  ledger.blocked.push(endpoint);
  throw new MeshRemoteBlockedError(
    endpoint,
    `mesh: refusing to reach "${endpoint}" from a test run — tests must be hermetic (loopback only). ` +
      `Inject a seam or a stub fetch instead; set ${ALLOW_REMOTE_ENV}=1 only when the test is deliberately exercising this guard`,
  );
}

/**
 * The transport-construction seam. Both `createClient` call sites go through
 * this so the RWS plane cannot drift away from the REST plane's rule.
 */
export function guardMeshConfig(config: MeshConfig, env: NodeJS.ProcessEnv = process.env): MeshConfig {
  assertEndpointReachable(config.endpoint, env);
  return config;
}

/**
 * Where the mesh config lives for this process. A test run never inherits the
 * user's real `~/.pi/xfer/mesh.config.json`: it resolves to a path that does
 * not exist (or to `XFER_MESH_CONFIG` when a test wants one), so a test that
 * forgets to inject a config fails loudly instead of quietly reading — and
 * reaching — whatever the developer happens to have configured. Interactive
 * sessions, the admin daemon and the adapter daemon always get the real path.
 */
export function resolveMeshConfigPath(realPath: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!inTestContext(env)) return realPath;
  const override = env.XFER_MESH_CONFIG;
  if (override) return override;
  return path.join(os.tmpdir(), `pi-xfer-test-${process.pid}-no-mesh.config.json`);
}
