import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authPreHandler } from "../lib/auth-pre.js";
import { prisma } from "../prisma.js";
import { canAccessDealer, canViewLeads } from "@gdms/auth";
import { aiCallQueue } from "../queue.js";
import { getIo } from "../socket.js";
import { initialCallState, SocketEvents, roomForAndroidDevice } from "@gdms/shared";
import type { LeadCategory, Prisma } from "@gdms/database";
import type { CallTaskPayload } from "@gdms/shared";
import { writeInquiryLog } from "../lib/inquiry-log.js";

const PAGE_SIZE = 50;

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(-10) : digits;
}

export async function registerLeadRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/inquiries", { preHandler: authPreHandler }, async (req, reply) => {
    if (!canViewLeads(req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const q = req.query as { dealerId?: string; q?: string; cursor?: string };
    const role = req.user!.role;
    const dealerId = q.dealerId ?? req.user!.dealerId ?? undefined;
    const search = q.q?.trim();

    const where: Prisma.InquiryWhereInput = {};
    if (role === "SUPER_ADMIN" && !dealerId) {
      // all dealers
    } else {
      if (!dealerId) return reply.code(400).send({ error: "dealerId required" });
      if (!canAccessDealer(req.user!.dealerId, dealerId, role)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      where.dealerId = dealerId;
    }

    if (search) {
      where.OR = [
        { phone: { contains: search } },
        { name: { contains: search, mode: "insensitive" } },
      ];
    }

    if (q.cursor) {
      where.id = { lt: q.cursor };
    }

    const includeDealerName = role === "SUPER_ADMIN";
    const rows = await prisma.inquiry.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: PAGE_SIZE + 1,
      ...(includeDealerName
        ? { include: { dealer: { select: { name: true } } } }
        : {}),
    });

    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const nextCursor = hasMore ? page[page.length - 1]?.id ?? null : null;

    const items = includeDealerName
      ? page.map((row) => {
          const r = row as typeof row & { dealer: { name: string } };
          const { dealer, ...rest } = r;
          return { ...rest, dealerName: dealer.name };
        })
      : page;

    return { items, nextCursor };
  });

  app.get<{ Params: { id: string } }>(
    "/v1/inquiries/:id/timeline",
    { preHandler: authPreHandler },
    async (req, reply) => {
      if (!canViewLeads(req.user!.role)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const row = await prisma.inquiry.findUnique({ where: { id: req.params.id } });
      if (!row) return reply.code(404).send({ error: "Not found" });
      if (!canAccessDealer(req.user!.dealerId, row.dealerId, req.user!.role)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const logs = await prisma.inquiryLog.findMany({
        where: { inquiryId: row.id },
        orderBy: { createdAt: "asc" },
        take: 100,
      });
      return logs;
    },
  );

  app.patch<{ Params: { id: string } }>("/v1/inquiries/:id", { preHandler: authPreHandler }, async (req, reply) => {
    if (!canViewLeads(req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
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
    if (body.followUpNotes !== undefined) {
      await writeInquiryLog(row.id, "notes_updated", { by: req.user!.sub });
    }
    if (body.category) {
      await writeInquiryLog(row.id, "category_updated", { category: body.category });
    }
    return updated;
  });

  app.post<{ Params: { id: string } }>(
    "/v1/inquiries/:id/call",
    { preHandler: authPreHandler },
    async (req, reply) => {
      if (!canViewLeads(req.user!.role)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const row = await prisma.inquiry.findUnique({ where: { id: req.params.id } });
      if (!row) return reply.code(404).send({ error: "Not found" });
      if (!canAccessDealer(req.user!.dealerId, row.dealerId, req.user!.role)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      await writeInquiryLog(row.id, "call_started", { by: req.user!.sub });
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

export { normalizePhone };
