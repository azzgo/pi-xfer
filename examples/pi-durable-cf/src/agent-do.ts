/**
 * The agent side of the node: a Durable Object that survives across requests
 * and cold starts, which is exactly what the serverless actor cannot promise.
 *
 * **The two persistence layers, kept apart.** rivetkit's actor state lives
 * engine-side in remote SQLite (forced under wasm) and belongs to the *mesh* —
 * a node description, the delivered-id dedupe window. This DO's storage belongs
 * to the *agent*: the handoffs it has received, what it answered, and anything
 * it needs to finish a job it already acknowledged. Nothing on the mesh reads
 * this storage, and nothing here may stand in for actor state.
 *
 * **Echo first.** With no credential configured the loop answers every handoff
 * with a fixed echo carrying the original handoff id, so the whole mesh path —
 * send in, receive, send back out — is provable before any API key exists. The
 * DeepSeek branch is behind `DEEPSEEK_API_KEY`: present, the same round trip
 * goes through a real model instead; absent, nothing changes.
 *
 * Experimental: see `examples/pi-durable-cf/README.md`.
 */
import type { MeshHandoffMessage } from "./mesh-actor.ts";

interface StoredHandoff {
  id: string;
  from: string;
  summary: string;
  receivedAt: string;
  /** What this DO answered, so a redelivery is answered identically rather than twice. */
  replyId: string;
}
/**
 * The slice of Durable Object storage this agent uses. Declared narrowly so the
 * DO's logic runs against a plain in-memory stand-in in tests — a DO has no
 * local emulator, which is exactly why this example's verification is manual.
 */
export interface AgentStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  list(prefix: string): Promise<Map<string, unknown>>;
}

export interface AgentReply {
  /** New handoff id for the reply — never the original id, which the sender already owns. */
  replyId: string;
  /** Original handoff id, so the sender can match the answer to what it sent. */
  inReplyTo: string;
  document: string;
}

/**
 * The serverless pool this node joins. `cloudflare` by default; the engine-side
 * runner-config must carry the same name, which is why the write-up names it in
 * exactly one place (wrangler.toml) and everywhere else refers to it.
 */
export function poolName(env: Pick<Env, "POOL_NAME">): string {
  return env.POOL_NAME ?? "cloudflare";
}

export interface Env {
  AGENT: DurableObjectNamespace;
  /** This node's mesh name (the actor key). Defaults to "cf-node". */
  NODE_NAME?: string;
  /**
   * The serverless pool this node joins. Defaults to "cloudflare"; the
   * out-of-band runner-config must be registered under the same name.
   */
  POOL_NAME?: string;
  /** Mesh engine endpoint — where the reply is enqueued, and the `endpoint` the registry needs. */
  MESH_ENDPOINT?: string;
  MESH_NAMESPACE?: string;
  MESH_TOKEN?: string;
  /**
   * RivetKit's own env-var fallback (`getRivetEndpoint` / `getRivetNamespace`),
   * read from the process environment. Set both in `wrangler.toml` `[vars]` so
   * every code path that bypasses the config object agrees with the secrets.
   */
  RIVET_ENDPOINT?: string;
  RIVET_NAMESPACE?: string;
  /** The Worker's own public URL, which the engine calls back into. */
  WORKER_PUBLIC_URL: string;
  /** Lifespan the serverless pool is configured with, in ms. Defaults to 30000. */
  SERVERLESS_REQUEST_LIFESPAN_MS?: number;
  /** Absent: the agent echoes. Present: the same round trip goes through DeepSeek. */
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
}

/**
 * Answer one handoff. Echo is the default and needs no credential; the model
 * branch is selected only when the key exists.
 */
export async function answerHandoff(
  message: MeshHandoffMessage,
  env: Pick<Env, "DEEPSEEK_API_KEY" | "DEEPSEEK_MODEL">,
): Promise<string> {
  if (!env.DEEPSEEK_API_KEY) return echoDocument(message);
  try {
    return await deepSeekDocument(message, env.DEEPSEEK_API_KEY, env.DEEPSEEK_MODEL);
  } catch (err) {
    // A model failure must still close the loop: the sender is waiting for one
    // answer, and a silent drop would read on the mesh as "accepted, never
    // answered". The echo says plainly that the model was unreachable.
    return echoDocument(message, `the model call failed (${err instanceof Error ? err.message : String(err)})`);
  }
}

export function echoDocument(message: MeshHandoffMessage, reason?: string): string {
  return [
    `# Echo from the Cloudflare node`,
    ``,
    `**In reply to**: handoff \`${message.id}\` from \`${message.from}\``,
    `**Summary received**: ${message.summary}`,
    `**Document length**: ${message.document.length} chars`,
    ``,
    reason
      ? `The DeepSeek branch was configured but did not answer: ${reason}. This is the fixed echo.`
      : `This is the fixed echo — no model was called. The mesh round trip is what this proves.`,
    ``,
    `Reply with \`kind: notification\`; this node does not wait for a further answer.`,
  ].join("\n");
}

async function deepSeekDocument(
  message: MeshHandoffMessage,
  apiKey: string,
  model = "deepseek-chat",
): Promise<string> {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are the Cloudflare end of a pi-xfer mesh round trip. Answer the handoff in one short markdown reply. " +
            "You are the receiver of a one-way handoff; you cannot ask follow-up questions.",
        },
        { role: "user", content: `${message.summary}\n\n${message.document}` },
      ],
    }),
  });
  if (!response.ok) throw new Error(`deepseek ${response.status} ${await response.text().catch(() => "")}`);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content;
  if (!text) throw new Error("deepseek returned no content");
  return text;
}

/**
 * The Durable Object. It owns the agent's memory and the reply it sends back
 * into the mesh.
 *
 * `deliver` is injected rather than imported so the DO's logic stays testable
 * without a mesh: in the Worker it is wired to a rivetkit client call, in a test
 * it is an array push.
 */
export class AgentDurableObject {
  private readonly state: { storage: AgentStorage };
  private readonly deliver: (target: string, reply: AgentReply) => Promise<void>;
  private readonly env: Pick<Env, "DEEPSEEK_API_KEY" | "DEEPSEEK_MODEL">;

  constructor(
    state: { storage: AgentStorage },
    deliver: (target: string, reply: AgentReply) => Promise<void>,
    env: Pick<Env, "DEEPSEEK_API_KEY" | "DEEPSEEK_MODEL">,
  ) {
    this.state = state;
    this.deliver = deliver;
    this.env = env;
  }

  /**
   * Record the handoff, answer it, send the answer back to its sender.
   *
   * A redelivery of an id already answered is *not* answered again: the reply
   * it produced the first time is returned instead, so the sender never sees two
   * answers to one handoff. The mesh's own dedupe covers the queue side; this
   * one covers the agent side, which the mesh cannot see.
   */
  async receive(message: MeshHandoffMessage): Promise<AgentReply> {
    const known = await this.state.storage.get(key(message.id)) as StoredHandoff | undefined;
    if (known) {
      return {
        replyId: known.replyId,
        inReplyTo: known.id,
        document: `# Already answered\n\nHandoff \`${known.id}\` was answered as \`${known.replyId}\` at ${known.receivedAt}.`,
      };
    }
    const replyId = replyIdFor(message.id);
    const document = await answerHandoff(message, this.env);
    await this.state.storage.put(key(message.id), {
      id: message.id,
      from: message.from,
      summary: message.summary,
      receivedAt: new Date().toISOString(),
      replyId,
    } satisfies StoredHandoff);
    const reply: AgentReply = { replyId, inReplyTo: message.id, document };
    await this.deliver(message.from, reply);
    return reply;
  }

  /** What this DO remembers, for the verification steps that check the agent layer. */
  async history(): Promise<StoredHandoff[]> {
    const entries = await this.state.storage.list("handoff:");
    return [...entries.values()] as StoredHandoff[];
  }
}

function key(handoffId: string): string {
  return `handoff:${handoffId}`;
}

/**
 * A reply id derived from the original, so a reader can pair the two by eye
 * while neither id is ever reused as the other's. Deliberately not random: the
 * pairing is the trace, and the receiver's dedupe window keys on the id alone.
 */
export function replyIdFor(handoffId: string): string {
  return `${handoffId}-echo`;
}
