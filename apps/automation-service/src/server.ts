import Fastify from "fastify";
import { z } from "zod";
import { env } from "./config.js";
import { runWorkflow, type ExecutePayload } from "./runner.js";
import type { WorkflowDefinition } from "@gdms/workflow-engine";

const bodySchema = z.object({
  runId: z.string(),
  dealerId: z.string(),
  gdmsUsername: z.string(),
  gdmsPassword: z.string(),
  workflow: z.custom<WorkflowDefinition>(),
  kind: z.string().optional(),
});

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ ok: true }));

  app.post("/internal/execute", async (req, reply) => {
    const hdr = req.headers["x-internal-secret"];
    if (hdr !== env.AUTOMATION_INTERNAL_SECRET) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const body = bodySchema.parse(req.body) as ExecutePayload;
    void runWorkflow(body).catch((err) => app.log.error(err));
    return reply.code(202).send({ accepted: true });
  });

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
