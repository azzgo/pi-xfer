import { Hono } from "hono";
import { AgentMemory, type Answer } from "./agent-do.ts";
import { engineReplyClient, type ReplyClient } from "./reply-client.ts";
import type { MeshHandoffMessage } from "./mesh-actor.ts";
import { nodeConfig, type Env, type NodeConfig } from "./node-config.ts";

export type AppEnv = { Bindings: Env };

export interface AppDeps {
  /** The mesh registry's `handler`, or a stand-in — the route cannot tell which, which is what makes it testable. */
  mesh: (request: Request) => Promise<Response>;
  /** Where the reply is enqueued. Absent in a test; the default talks to the engine. */
  replyClient?: (config: NodeConfig) => ReplyClient;
}

/**
 * The whole HTTP surface. Hono is not decoration: the routes are the readable part of a serverless
 * node, and `app.all("*")` is what lets a wasm registry own its own paths.
 */
export function createApp({ mesh, replyClient = engineReplyClient }: AppDeps) {
  return new Hono<AppEnv>()
    .get("/", (c) => {
      const { nodeName, basePath } = nodeConfig(c.env, c.req.url);
      return c.json({ node: nodeName, mesh: basePath, routes: ["/health", "/agent/answer"] });
    })
    .get("/health", (c) => {
      const { nodeName, endpoint } = nodeConfig(c.env, c.req.url);
      return c.json({ ok: true, node: nodeName, engine: Boolean(endpoint) });
    })
    .post("/agent/answer", async (c) => {
      const message = await c.req.json<MeshHandoffMessage>();
      const answer = await new AgentMemory(c.env).answer(message);
      if (answer.first) await reply(replyClient, nodeConfig(c.env, c.req.url), message, answer);
      return c.json(answer);
    })
    .all("*", (c) => mesh(c.req.raw));
}

async function reply(
  replyClient: (config: NodeConfig) => ReplyClient,
  config: NodeConfig,
  message: MeshHandoffMessage,
  answer: Answer,
): Promise<void> {
  await replyClient(config).send(message.from, {
    id: answer.replyId,
    from: config.nodeName,
    to: message.from,
    summary: `echo of ${message.id}`,
    document: answer.document,
  });
}
