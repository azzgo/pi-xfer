import type { MeshHandoffMessage } from "./mesh-actor.ts";
import type { Env } from "./node-config.ts";

interface StoredHandoff {
  id: string;
  from: string;
  summary: string;
  receivedAt: string;
  replyId: string;
}

/** The slice of Durable Object storage this agent uses, declared narrowly so it runs against a plain in-memory stand-in. */
export interface AgentStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export interface Answer {
  /** A new handoff id — never the original, which the sender already owns. */
  replyId: string;
  document: string;
  /** False when this handoff had already been answered: the caller must not send a second reply. */
  first: boolean;
}

export type Model = { DEEPSEEK_API_KEY?: string; DEEPSEEK_MODEL?: string };

/**
 * The one function to replace: turn an incoming Handoff into a document. The echo is the default and
 * needs no credential; setting `DEEPSEEK_API_KEY` sends the same round trip through a model instead.
 */
export async function answerHandoff(message: MeshHandoffMessage, model: Model): Promise<string> {
  if (!model.DEEPSEEK_API_KEY) return echoDocument(message);
  try {
    return await deepSeekDocument(message, model.DEEPSEEK_API_KEY, model.DEEPSEEK_MODEL);
  } catch (err) {
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
 * A memory is what the serverless actor cannot promise: it is torn down between hands. `storage` is
 * the Durable Object's, so a redelivered handoff is answered with the id it produced the first
 * time and the sender never sees two answers to one handoff.
 */
export class AgentMemory {
  private readonly storage: AgentStorage;
  private readonly model: Model;

  constructor(env: Env) {
    this.storage = env.AGENT_STORAGE;
    this.model = env;
  }

  async answer(message: MeshHandoffMessage): Promise<Answer> {
    const known = (await this.storage.get(key(message.id))) as StoredHandoff | undefined;
    if (known) {
      return {
        replyId: known.replyId,
        document: `# Already answered\n\nHandoff \`${known.id}\` was answered as \`${known.replyId}\` at ${known.receivedAt}.`,
        first: false,
      };
    }
    const replyId = replyIdFor(message.id);
    const document = await answerHandoff(message, this.model);
    await this.storage.put(key(message.id), {
      id: message.id,
      from: message.from,
      summary: message.summary,
      receivedAt: new Date().toISOString(),
      replyId,
    } satisfies StoredHandoff);
    return { replyId, document, first: true };
  }
}

function key(handoffId: string): string {
  return `handoff:${handoffId}`;
}

/** Derived, not random, so a reader pairs the two ids by eye and neither is ever reused as the other. */
export function replyIdFor(handoffId: string): string {
  return `${handoffId}-echo`;
}
