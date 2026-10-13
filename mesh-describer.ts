/**
 * Mesh-backed description lookup for processes that are *not* the mesh node —
 * today the broker daemon, whose `targets` op answers the web picker's mandatory
 * pre-send query.
 *
 * rivetkit's client is imported lazily through a computed specifier so bundlers
 * leave it external: `broker.cjs` must not inline the mesh runtime, and where
 * rivetkit is not resolvable at all (an installed package has no node_modules)
 * the describer degrades to "no descriptions" instead of breaking targets.list.
 *
 * This is the read side only: one named node in, one description out. No bulk
 * fan-out, no listing integration — listings stay names-only by design.
 */
import { XFER_INSTANCE_ACTOR, loadMeshConfig } from "./mesh-config.ts";
import type { TargetDescriber } from "./targets.ts";

/** Bound on one describe call so an unreachable actor cannot stall targets.list. */
const DESCRIBE_TIMEOUT_MS = 5_000;

/** Action name on the xfer-instance actor; kept here so callers share the wire name. */
export const GET_DESCRIPTION_ACTION = "getDescription";

/** Returns the stored description, or undefined when it cannot be read. */
export function createMeshDescriber(configPath: string): TargetDescriber {
  let pending: Promise<MeshClient | null> | null = null;
  const client = (): Promise<MeshClient | null> => (pending ??= connect(configPath));

  return async (name: string): Promise<string | undefined> => {
    const handle = await client();
    if (!handle) return undefined;
    const description: unknown = await handle.client
      .get(XFER_INSTANCE_ACTOR, [name])
      .action({ name: GET_DESCRIPTION_ACTION, args: [], signal: AbortSignal.timeout(DESCRIBE_TIMEOUT_MS) });
    return typeof description === "string" && description.trim() !== "" ? description : undefined;
  };
}

interface MeshClient {
  client: { get(actor: string, key: string[]): { action(opts: { name: string; args: unknown[]; signal?: AbortSignal }): Promise<unknown> } };
}

async function connect(configPath: string): Promise<MeshClient | null> {
  try {
    const config = loadMeshConfig(configPath);
    // Computed specifier on purpose: a literal `import("rivetkit/client")` would
    // be inlined by esbuild and drag the whole mesh runtime into broker.cjs.
    const specifier = ["rivetkit", "client"].join("/");
    const { createClient } = (await import(specifier)) as { createClient(config: unknown): MeshClient["client"] };
    return { client: createClient({ endpoint: config.endpoint, namespace: config.namespace, token: config.token }) };
  } catch {
    return null;
  }
}