import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authPreHandler } from "../lib/auth-pre.js";
import { prisma } from "../prisma.js";
import { canAccessDealer, canManageDealers, hashPassword } from "@gdms/auth";
import { writeAuditEvent } from "../lib/audit.js";

function internalEmail(username: string): string {
  return `${username.toLowerCase()}@gdms.internal`;
}

const createDealerSchema = z.object({
  name: z.string().min(1),
  maxTeamLeaders: z.number().int().min(0).max(500).optional(),
  maxSalesConsultants: z.number().int().min(0).max(5000).optional(),
  admin: z.object({
    username: z.string().min(2).max(32).regex(/^[a-zA-Z0-9._-]+$/),
    password: z.string().min(4).max(128),
    displayName: z.string().min(1).max(80).optional(),
  }),
});

const patchDealerSchema = z.object({
  name: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
  maxTeamLeaders: z.number().int().min(0).max(500).optional(),
  maxSalesConsultants: z.number().int().min(0).max(5000).optional(),
});

export async function registerDealerRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/dealers", { preHandler: authPreHandler }, async (req, reply) => {
    if (!canManageDealers(req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const body = createDealerSchema.parse(req.body);
    const passwordHash = await hashPassword(body.admin.password);
    try {
      const result = await prisma.$transaction(async (tx) => {
        const dealer = await tx.dealer.create({
          data: {
            name: body.name,
            maxTeamLeaders: body.maxTeamLeaders ?? 10,
            maxSalesConsultants: body.maxSalesConsultants ?? 50,
          },
        });
        const admin = await tx.user.create({
          data: {
            username: body.admin.username,
            email: internalEmail(body.admin.username),
            passwordHash,
            role: "DEALER_ADMIN",
            dealerId: dealer.id,
            displayName: body.admin.displayName?.trim() || null,
            isActive: true,
          },
          select: { id: true, username: true, displayName: true, role: true },
        });
        return { ...dealer, admin };
      });
      return result;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Unique constraint")) {
        return reply.code(409).send({ error: "Admin username already exists" });
      }
      throw e;
    }
  });

  const dealerListInclude = {
    _count: { select: { users: true } },
    users: {
      where: { role: "DEALER_ADMIN" as const },
      select: { id: true, username: true, displayName: true, isActive: true },
      orderBy: { username: "asc" as const },
    },
  };

  app.get("/v1/dealers", { preHandler: authPreHandler }, async (req) => {
    if (req.user!.role === "SUPER_ADMIN") {
      return prisma.dealer.findMany({
        orderBy: { createdAt: "desc" },
        include: dealerListInclude,
      });
    }
    if (!req.user!.dealerId) return [];
    const d = await prisma.dealer.findUnique({
      where: { id: req.user!.dealerId },
      include: dealerListInclude,
    });
    return d ? [d] : [];
  });

  app.get("/v1/dealers/:id", { preHandler: authPreHandler }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!canAccessDealer(req.user!.dealerId, id, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const dealer = await prisma.dealer.findUnique({
      where: { id },
      include: dealerListInclude,
    });
    if (!dealer) return reply.code(404).send({ error: "Not found" });
    return dealer;
  });

  app.patch("/v1/dealers/:id", { preHandler: authPreHandler }, async (req, reply) => {
    if (!canManageDealers(req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const { id } = req.params as { id: string };
    const body = patchDealerSchema.parse(req.body);
    const dealer = await prisma.dealer.update({
      where: { id },
      data: body,
    });
    return dealer;
  });

  app.delete("/v1/dealers/:id", { preHandler: authPreHandler }, async (req, reply) => {
    if (!canManageDealers(req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const { id } = req.params as { id: string };
    const dealer = await prisma.dealer.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
    if (!dealer) return reply.code(404).send({ error: "Dealer not found" });

    await prisma.$transaction(async (tx) => {
      const userIds = (
        await tx.user.findMany({ where: { dealerId: id }, select: { id: true } })
      ).map((u) => u.id);
      if (userIds.length > 0) {
        await tx.notification.deleteMany({ where: { userId: { in: userIds } } });
        await tx.user.updateMany({ where: { dealerId: id }, data: { reportsToUserId: null } });
        await tx.user.deleteMany({ where: { dealerId: id } });
      }
      await tx.dealer.delete({ where: { id } });
    });

    await writeAuditEvent({
      actorUserId: req.user!.sub,
      action: "dealer_deleted",
      entityType: "Dealer",
      entityId: id,
      payload: { name: dealer.name },
    });

    return { ok: true };
  });
}
