import Fastify from "fastify";
import { z } from "zod";
import { env } from "./config.js";
import { hasActiveSession } from "./active-sessions.js";
import { resumeEnquiryTransfer } from "./resume-enquiry-transfer.js";
import { retryEnquiryTransfer } from "./retry-enquiry-transfer.js";
import { runWorkflow, type ExecutePayload } from "./runner.js";
import type { WorkflowDefinition } from "@gdms/workflow-engine";
import { ENABLED_AUTOMATION_OPERATIONS, AUTOMATION_SOURCES } from "@gdms/shared";

const workflowDefSchema = z.custom<WorkflowDefinition>();

const bodySchema = z.object({
  runId: z.string(),
  dealerId: z.string(),
  gdmsUsername: z.string(),
  gdmsPassword: z.string(),
  loginWorkflow: workflowDefSchema,
  operationWorkflow: workflowDefSchema,
  operation: z.enum(ENABLED_AUTOMATION_OPERATIONS),
  sources: z.array(z.enum(AUTOMATION_SOURCES)).min(1),
  subSources: z
    .object({
      Digital: z.array(z.string().min(1)).optional(),
      CRM: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  /** @deprecated legacy single-workflow payloads */
  workflow: workflowDefSchema.optional(),
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

  app.post("/internal/resume-enquiry-transfer", async (req, reply) => {
    const hdr = req.headers["x-internal-secret"];
    if (hdr !== env.AUTOMATION_INTERNAL_SECRET) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const body = bodySchema.parse(req.body) as ExecutePayload;
    void resumeEnquiryTransfer(body).catch((err) => app.log.error(err));
    return reply.code(202).send({ accepted: true });
  });

  app.post("/internal/retry-enquiry-transfer", async (req, reply) => {
    const hdr = req.headers["x-internal-secret"];
    if (hdr !== env.AUTOMATION_INTERNAL_SECRET) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const { runId } = z.object({ runId: z.string() }).parse(req.body);
    if (!hasActiveSession(runId)) {
      return reply.code(409).send({
        error: "No active browser session for this run. Start a new automation from the dashboard.",
      });
    }
    void retryEnquiryTransfer(runId).catch((err) => app.log.error(err));
    return reply.code(202).send({ accepted: true });
  });

  app.get("/internal/session-active/:runId", async (req, reply) => {
    const hdr = req.headers["x-internal-secret"];
    if (hdr !== env.AUTOMATION_INTERNAL_SECRET) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const { runId } = req.params as { runId: string };
    return { active: hasActiveSession(runId) };
  });

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "EADDRINUSE") {
    console.error(
      `\n[@gdms/automation-service] Port ${env.PORT} is already in use — stop the other process or change PORT in apps/automation-service/.env\n`,
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});
