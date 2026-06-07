import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { Redis } from "ioredis";
import fs from "node:fs";
import path from "node:path";
import { createPrisma } from "@gdms/database";
import {
  SocketEvents,
  WORKFLOW_REDIS_CHANNEL,
  initialCallState,
  nextCallState,
  type CallStateMachineState,
} from "@gdms/shared";
import { env } from "./config.js";
import { inferIntent, inferLostInquiryCancellation, inferLostInquirySurveillance } from "./ollama.js";

const prisma = createPrisma();

async function publish(redis: Redis, dealerId: string, type: string, payload: unknown) {
  await redis.publish(WORKFLOW_REDIS_CHANNEL, JSON.stringify({ type, dealerId, payload }));
}

async function runCallSession(aiCallId: string): Promise<void> {
  const redis = new Redis(env.REDIS_URL);
  const call = await prisma.aiCall.findUnique({ where: { id: aiCallId } });
  if (!call) return;
  const inquiry = await prisma.inquiry.findUnique({ where: { id: call.inquiryId } });
  if (!inquiry) return;

  await publish(redis, inquiry.dealerId, SocketEvents.CALL_STARTED, {
    aiCallId,
    phone: inquiry.phone,
  });

  let sm = call.stateMachine as unknown as CallStateMachineState;
  if (!sm?.current) sm = initialCallState();

  const utterance =
    "Hi, I was asking about Hyundai. When can delivery happen?";

  for (let i = 0; i < 4 && sm.current !== "STATE_4"; i++) {
    const intent = await inferIntent(sm.current, utterance);
    const next = nextCallState(sm.current, intent.next);
    sm = {
      current: next,
      history: [...sm.history, { state: next, note: intent.summary }],
    };
    await prisma.callLog.create({
      data: {
        aiCallId,
        phase: sm.current,
        transcript: utterance.slice(0, 500),
        metrics: { intent } as object,
      },
    });
    await prisma.aiCall.update({ where: { id: aiCallId }, data: { stateMachine: sm as object } });
  }

  await prisma.aiCall.update({
    where: { id: aiCallId },
    data: { outcome: "COMPLETED", stateMachine: sm as object },
  });

  await publish(redis, inquiry.dealerId, SocketEvents.CALL_COMPLETED, {
    aiCallId,
    outcome: "COMPLETED",
  });
  redis.disconnect();
}

async function main(): Promise<void> {
  const app = Fastify({ logger: true });
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } });

  app.get("/health", async () => ({ ok: true }));

  app.post("/internal/call/start", async (req, reply) => {
    const hdr = req.headers["x-internal-secret"];
    if (hdr !== env.AI_INTERNAL_SECRET) return reply.code(401).send({ error: "Unauthorized" });
    const body = z.object({ aiCallId: z.string() }).parse(req.body);
    void runCallSession(body.aiCallId).catch((e) => app.log.error(e));
    return { accepted: true };
  });

  app.post("/internal/lost-inquiry/cancellation", async (req, reply) => {
    const hdr = req.headers["x-internal-secret"];
    if (hdr !== env.AI_INTERNAL_SECRET) return reply.code(401).send({ error: "Unauthorized" });
    const body = z
      .object({
        remark: z.string(),
        reasonFailureOptions: z.array(z.string()),
        lostDueToOptions: z.array(z.string()),
        lostDueToSubOptions: z.array(z.string()),
        model: z.string().optional(),
      })
      .parse(req.body);
    const result = await inferLostInquiryCancellation(body);
    if (!result) return reply.code(422).send({ error: "Could not resolve cancellation dropdowns" });
    return result;
  });

  app.post("/internal/lost-inquiry/surveillance", async (req, reply) => {
    const hdr = req.headers["x-internal-secret"];
    if (hdr !== env.AI_INTERNAL_SECRET) return reply.code(401).send({ error: "Unauthorized" });
    const body = z
      .object({
        step: z.string(),
        error: z.string(),
        remark: z.string().nullable(),
        snapshot: z.record(z.unknown()),
        attempt: z.number().int().min(1),
        model: z.string().optional(),
      })
      .parse(req.body);
    const result = await inferLostInquirySurveillance(body);
    if (!result) return reply.code(422).send({ error: "Could not plan surveillance recovery" });
    return result;
  });

  app.post("/internal/train/voice", async (req, reply) => {
    const hdr = req.headers["x-internal-secret"];
    if (hdr !== env.AI_INTERNAL_SECRET) return reply.code(401).send({ error: "Unauthorized" });
    const body = z.object({ profileId: z.string() }).parse(req.body);
    const profile = await prisma.voiceProfile.findUnique({ where: { id: body.profileId } });
    if (!profile) return reply.code(404).send({ error: "Not found" });
    await prisma.voiceProfile.update({
      where: { id: profile.id },
      data: { status: "READY", modelVersion: "cpu-mvp-1" },
    });
    return { ok: true };
  });

  app.post("/v1/voice-profiles/:dealerId/upload", async (req) => {
    const dealerId = (req.params as { dealerId: string }).dealerId;
    const parts = req.parts();
    const dir = path.join(env.VOICE_DATA_DIR, dealerId);
    fs.mkdirSync(dir, { recursive: true });
    for await (const part of parts) {
      if (part.type === "file" && part.fieldname === "samples") {
        const dest = path.join(dir, part.filename ?? "sample.wav");
        await fs.promises.writeFile(dest, await part.toBuffer());
      }
    }
    const profile = await prisma.voiceProfile.create({
      data: {
        dealerId,
        artifactPath: dir,
        status: "PENDING",
      },
    });
    return profile;
  });

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "EADDRINUSE") {
    console.error(
      `\n[@gdms/ai-service] Port ${env.PORT} is already in use — stop the other process or change PORT in apps/ai-service/.env\n`,
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});
