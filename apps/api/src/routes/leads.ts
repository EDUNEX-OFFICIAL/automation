import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authPreHandler } from "../lib/auth-pre.js";
import { prisma } from "../prisma.js";
import { canAccessDealer } from "@gdms/auth";
import { aiCallQueue } from "../queue.js";
import { getIo } from "../socket.js";
import { initialCallState, SocketEvents, roomForAndroidDevice } from "@gdms/shared";
import type { LeadCategory, Prisma } from "@prisma/client";
import type { CallTaskPayload } from "@gdms/shared";

export async function registerLeadRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/inquiries", { preHandler: authPreHandler }, async (req, reply) => {
    const q = req.query as { dealerId?: string };
    const role = req.user!.role;
    const dealerId = q.dealerId ?? req.user!.dealerId ?? undefined;

    if (role === "SUPER_ADMIN" && !dealerId) {
      const rows = await prisma.inquiry.findMany({
        orderBy: { updatedAt: "desc" },
        take: 300,
        include: { dealer: { select: { name: true } } },
      });
      return rows.map(({ dealer, ...rest }) => ({ ...rest, dealerName: dealer.name }));
    }

    if (!dealerId) return reply.code(400).send({ error: "dealerId required" });
    if (!canAccessDealer(req.user!.dealerId, dealerId, role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const includeDealerName = role === "SUPER_ADMIN";
    const rows = await prisma.inquiry.findMany({
      where: { dealerId },
      orderBy: { updatedAt: "desc" },
      take: 200,
      ...(includeDealerName
        ? { include: { dealer: { select: { name: true } } } }
        : {}),
    });
    if (includeDealerName) {
      return rows.map((row) => {
        const r = row as typeof row & { dealer: { name: string } };
        const { dealer, ...rest } = r;
        return { ...rest, dealerName: dealer.name };
      });
    }
    return rows;
  });

  app.patch<{ Params: { id: string } }>("/v1/inquiries/:id", { preHandler: authPreHandler }, async (req, reply) => {
    const body = z
      .object({
        followUpNotes: z.string().optional(),
        status: z.string().optional(),
        category: z.enum(["HOT", "WARM", "FAKE", "NEED_CALL"]).optional(),
      })
      .parse(req.body);
    const row = await prisma.inquiry.findUnique({ where: { id: req.params.id } });
    if (!row) return reply.code(404).send({ error: "Not found" });
    if (!canAccessDealer(req.user!.dealerId, row.dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const updated = await prisma.inquiry.update({
      where: { id: row.id },
      data: {
        followUpNotes: body.followUpNotes ?? undefined,
        status: body.status ?? undefined,
        category: (body.category as LeadCategory | undefined) ?? undefined,
      },
    });
    return updated;
  });

  app.post<{ Params: { id: string } }>(
    "/v1/inquiries/:id/call",
    { preHandler: authPreHandler },
    async (req, reply) => {
      const row = await prisma.inquiry.findUnique({ where: { id: req.params.id } });
      if (!row) return reply.code(404).send({ error: "Not found" });
      if (!canAccessDealer(req.user!.dealerId, row.dealerId, req.user!.role)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const device = await prisma.androidDevice.findFirst({
        where: { dealerId: row.dealerId, status: "ONLINE" },
      });
      const profile = await prisma.voiceProfile.findFirst({
        where: { dealerId: row.dealerId, status: "READY" },
      });
      const call = await prisma.aiCall.create({
        data: {
          inquiryId: row.id,
          stateMachine: JSON.parse(JSON.stringify(initialCallState())) as Prisma.InputJsonValue,
          androidDeviceId: device?.id,
          voiceProfileId: profile?.id,
        },
      });
      if (device?.deviceId) {
        getIo()
          .to(roomForAndroidDevice(device.deviceId))
          .emit(SocketEvents.CALL_TASK, {
            type: "CALL_TASK",
            taskId: call.id,
            aiCallId: call.id,
            inquiryId: row.id,
            number: row.phone,
          } satisfies CallTaskPayload);
      }
      await aiCallQueue.add("dial", { aiCallId: call.id }, { jobId: call.id });
      return { aiCallId: call.id };
    },
  );
}
