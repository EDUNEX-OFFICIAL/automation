import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { randomBytes, createHash } from "node:crypto";
import { authPreHandler } from "../lib/auth-pre.js";
import { verifyAndroidSocketAuth } from "../lib/android-device.js";
import { prisma } from "../prisma.js";
import { canAccessDealer, hashPassword } from "@gdms/auth";
import { redis } from "../redis.js";
import { getIo } from "../socket.js";
import { SocketEvents, roomForDealer, type CallStatusUpdatePayload } from "@gdms/shared";

function hashPairing(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export async function registerAndroidRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/android/pair", { preHandler: authPreHandler }, async (req, reply) => {
    const body = z.object({ dealerId: z.string() }).parse(req.body);
    if (!canAccessDealer(req.user!.dealerId, body.dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const code = randomBytes(4).toString("hex").slice(0, 8).toUpperCase();
    await redis.set(`pair:${code}`, body.dealerId, "EX", 600);
    return { pairingCode: code, expiresInSec: 600 };
  });

  app.post("/v1/android/claim", async (req, reply) => {
    const body = z
      .object({
        pairingCode: z.string().min(4).transform((s) => s.toUpperCase()),
        deviceId: z.string().min(4),
      })
      .parse(req.body);
    const dealerId = await redis.get(`pair:${body.pairingCode}`);
    if (!dealerId) return reply.code(400).send({ error: "Invalid or expired code" });
    await redis.del(`pair:${body.pairingCode}`);
    const pairingCodeHash = hashPairing(body.pairingCode + dealerId);
    const socketTokenPlain = randomBytes(24).toString("hex");
    const socketTokenHash = await hashPassword(socketTokenPlain);
    const dev = await prisma.androidDevice.upsert({
      where: { deviceId: body.deviceId },
      create: {
        dealerId,
        deviceId: body.deviceId,
        pairingCodeHash,
        socketTokenHash,
        status: "ONLINE",
      },
      update: {
        dealerId,
        pairingCodeHash,
        socketTokenHash,
        status: "ONLINE",
        lastSeenAt: new Date(),
      },
    });
    return {
      ok: true,
      dealerId: dev.dealerId,
      deviceDbId: dev.id,
      socketToken: socketTokenPlain,
    };
  });

  app.post("/v1/android/heartbeat-mvp", async (req, _reply) => {
    const body = z.object({ deviceId: z.string().min(2) }).parse(req.body);
    await prisma.androidDevice.updateMany({
      where: { deviceId: body.deviceId },
      data: { lastSeenAt: new Date(), status: "ONLINE" },
    });
    return { ok: true };
  });

  const callPhaseSchema = z.enum(["DIALING", "RINGING", "CONNECTED", "ENDED", "FAILED"]);

  app.post("/v1/android/call-status", async (req, reply) => {
    const body = z
      .object({
        deviceId: z.string().min(2),
        socketToken: z.string().min(8),
        aiCallId: z.string().min(4),
        phase: callPhaseSchema,
        durationSec: z.number().int().nonnegative().optional(),
        error: z.string().max(2000).optional(),
      })
      .parse(req.body);

    const dev = await verifyAndroidSocketAuth(body.deviceId, body.socketToken);
    if (!dev) return reply.code(401).send({ error: "Unauthorized" });

    const call = await prisma.aiCall.findUnique({
      where: { id: body.aiCallId },
      include: { inquiry: true },
    });
    if (!call) return reply.code(404).send({ error: "Call not found" });
    if (call.inquiry.dealerId !== dev.dealerId) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const metrics: Prisma.InputJsonValue | undefined =
      body.durationSec != null ? { durationSec: body.durationSec } : undefined;

    await prisma.callLog.create({
      data: {
        aiCallId: call.id,
        phase: body.phase,
        metrics,
        error: body.error,
      },
    });

    const patch: Prisma.AiCallUpdateInput = { lastCallPhase: body.phase };
    if (body.phase === "ENDED") {
      patch.callEndedAt = new Date();
      if (!call.outcome) patch.outcome = "PHONE_COMPLETED";
    } else if (body.phase === "FAILED") {
      patch.callEndedAt = new Date();
      patch.outcome = "PHONE_FAILED";
    }
    await prisma.aiCall.update({ where: { id: call.id }, data: patch });

    const payload: CallStatusUpdatePayload = {
      aiCallId: call.id,
      inquiryId: call.inquiryId,
      dealerId: dev.dealerId,
      phase: body.phase,
      durationSec: body.durationSec,
      error: body.error,
    };
    getIo().to(roomForDealer(dev.dealerId)).emit(SocketEvents.CALL_STATUS_UPDATE, payload);

    return { ok: true };
  });

  app.post("/v1/android/rotate-socket-token", async (req, reply) => {
    const body = z
      .object({
        deviceId: z.string().min(2),
        currentSocketToken: z.string().min(8),
      })
      .parse(req.body);
    const dev = await verifyAndroidSocketAuth(body.deviceId, body.currentSocketToken);
    if (!dev) return reply.code(401).send({ error: "Unauthorized" });
    const socketTokenPlain = randomBytes(24).toString("hex");
    const socketTokenHash = await hashPassword(socketTokenPlain);
    await prisma.androidDevice.update({
      where: { id: dev.id },
      data: { socketTokenHash, lastSeenAt: new Date() },
    });
    return { socketToken: socketTokenPlain };
  });
}
