import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authPreHandler } from "../lib/auth-pre.js";
import { prisma } from "../prisma.js";
import {
  hashPassword,
  canManageDealerUsers,
  canAccessTeamUsersApi,
  canAccessDealer,
  canDeleteTeamUser,
  rolesCreatableBy,
} from "@gdms/auth";
import type { TeamType, UserRole } from "@gdms/database";
import { writeAuditEvent } from "../lib/audit.js";

const createUserSchema = z.object({
  username: z.string().min(2).max(32).regex(/^[a-zA-Z0-9._-]+$/),
  password: z.string().min(1),
  displayName: z.string().min(1).max(80).optional(),
  role: z.enum(["DEALER_ADMIN", "TEAM_LEADER", "SALES_CONSULTANT"]),
  dealerId: z.string().optional(),
  reportsToUserId: z.string().optional(),
  teamType: z.enum(["DIGITAL", "FIELD"]).optional(),
});

function internalEmail(username: string): string {
  return `${username.toLowerCase()}@gdms.internal`;
}

const userSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  email: true,
  role: true,
  dealerId: true,
  reportsToUserId: true,
  teamType: true,
  isActive: true,
  reportsTo: { select: { id: true, username: true, teamType: true } },
} as const;

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/users", { preHandler: authPreHandler }, async (req, reply) => {
    if (!canAccessTeamUsersApi(req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    if (req.user!.role === "TEAM_LEADER") {
      return prisma.user.findMany({
        where: {
          dealerId: req.user!.dealerId ?? undefined,
          OR: [{ id: req.user!.sub }, { reportsToUserId: req.user!.sub, role: "SALES_CONSULTANT" }],
        },
        select: userSelect,
        orderBy: { username: "asc" },
      });
    }

    if (req.user!.role === "SUPER_ADMIN") {
      return prisma.user.findMany({
        select: userSelect,
        orderBy: [{ dealerId: "asc" }, { username: "asc" }],
      });
    }

    if (!req.user!.dealerId) return [];
    return prisma.user.findMany({
      where: { dealerId: req.user!.dealerId },
      select: userSelect,
      orderBy: { username: "asc" },
    });
  });

  app.post("/v1/users", { preHandler: authPreHandler }, async (req, reply) => {
    if (!canAccessTeamUsersApi(req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const body = createUserSchema.parse(req.body);
    const actor = req.user!;
    const allowed = rolesCreatableBy(actor.role);
    if (!allowed.includes(body.role)) {
      return reply.code(403).send({ error: "Forbidden role for your account" });
    }

    let dealerId = body.dealerId ?? actor.dealerId ?? null;
    let reportsToUserId = body.reportsToUserId ?? null;
    let teamType: TeamType | null = body.teamType ?? null;

    if (actor.role === "DEALER_ADMIN") {
      dealerId = actor.dealerId;
    }

    if (actor.role === "TEAM_LEADER") {
      if (body.role !== "SALES_CONSULTANT") {
        return reply.code(403).send({ error: "Team Leaders can only create Sales Consultants" });
      }
      dealerId = actor.dealerId;
      reportsToUserId = actor.sub;
      teamType = null;
    }

    if (!dealerId) {
      return reply.code(400).send({ error: "dealerId required" });
    }
    if (!canAccessDealer(actor.dealerId, dealerId, actor.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const dealer = await prisma.dealer.findUnique({ where: { id: dealerId } });
    if (!dealer?.isActive) {
      return reply.code(403).send({ error: "Dealer is disabled" });
    }

    if (body.role === "TEAM_LEADER") {
      if (!teamType) {
        return reply.code(400).send({ error: "teamType required for Team Leader (DIGITAL or FIELD)" });
      }
      const tlCount = await prisma.user.count({
        where: { dealerId, role: "TEAM_LEADER", isActive: true },
      });
      if (tlCount >= dealer.maxTeamLeaders) {
        return reply.code(400).send({ error: `Team Leader limit reached (${dealer.maxTeamLeaders})` });
      }
      reportsToUserId = null;
    } else {
      teamType = null;
    }

    if (body.role === "SALES_CONSULTANT") {
      const scCount = await prisma.user.count({
        where: { dealerId, role: "SALES_CONSULTANT", isActive: true },
      });
      if (scCount >= dealer.maxSalesConsultants) {
        return reply
          .code(400)
          .send({ error: `Sales Consultant limit reached (${dealer.maxSalesConsultants})` });
      }
      if (!reportsToUserId) {
        return reply.code(400).send({ error: "Select a Team Leader for this Sales Consultant" });
      }
      const tl = await prisma.user.findFirst({
        where: {
          id: reportsToUserId,
          dealerId,
          role: "TEAM_LEADER",
          isActive: true,
        },
      });
      if (!tl) {
        return reply.code(400).send({ error: "Invalid Team Leader for this dealer" });
      }
    }

    if (body.role === "TEAM_LEADER" && reportsToUserId) {
      return reply.code(400).send({ error: "Team Leader cannot report to another user" });
    }

    const passwordHash = await hashPassword(body.password);
    const role = body.role as UserRole;
    try {
      const user = await prisma.user.create({
        data: {
          username: body.username,
          email: internalEmail(body.username),
          passwordHash,
          displayName: body.displayName?.trim() || null,
          role,
          dealerId,
          reportsToUserId: body.role === "SALES_CONSULTANT" ? reportsToUserId : null,
          teamType: body.role === "TEAM_LEADER" ? teamType : null,
        },
        select: userSelect,
      });
      await writeAuditEvent({
        dealerId,
        actorUserId: actor.sub,
        action: "user_created",
        entityType: "User",
        entityId: user.id,
        payload: { role: user.role, username: user.username },
      });
      return user;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Unique constraint")) {
        return reply.code(409).send({ error: "Username already exists" });
      }
      throw e;
    }
  });

  app.patch("/v1/users/:id", { preHandler: authPreHandler }, async (req, reply) => {
    if (!canAccessTeamUsersApi(req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const { id } = req.params as { id: string };
    const body = z
      .object({
        isActive: z.boolean().optional(),
        reportsToUserId: z.string().nullable().optional(),
        teamType: z.enum(["DIGITAL", "FIELD"]).optional(),
      })
      .parse(req.body);

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return reply.code(404).send({ error: "Not found" });

    if (target.role === "SUPER_ADMIN" && req.user!.role !== "SUPER_ADMIN") {
      return reply.code(403).send({ error: "Forbidden" });
    }

    if (
      target.dealerId &&
      !canAccessDealer(req.user!.dealerId, target.dealerId, req.user!.role)
    ) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    if (req.user!.role === "TEAM_LEADER") {
      if (target.reportsToUserId !== req.user!.sub || target.role !== "SALES_CONSULTANT") {
        return reply.code(403).send({ error: "You can only manage your own Sales Consultants" });
      }
      if (body.reportsToUserId !== undefined || body.teamType !== undefined) {
        return reply.code(403).send({ error: "Forbidden" });
      }
    } else if (!canManageDealerUsers(req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    if (body.teamType !== undefined && target.role !== "TEAM_LEADER") {
      return reply.code(400).send({ error: "teamType only applies to Team Leaders" });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        isActive: body.isActive,
        reportsToUserId: canManageDealerUsers(req.user!.role) ? body.reportsToUserId : undefined,
        teamType: target.role === "TEAM_LEADER" ? body.teamType : undefined,
      },
      select: userSelect,
    });
    await writeAuditEvent({
      dealerId: target.dealerId,
      actorUserId: req.user!.sub,
      action: "user_updated",
      entityType: "User",
      entityId: id,
      payload: body,
    });
    return updated;
  });

  app.delete("/v1/users/:id", { preHandler: authPreHandler }, async (req, reply) => {
    if (!canAccessTeamUsersApi(req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const { id } = req.params as { id: string };
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return reply.code(404).send({ error: "Not found" });

    const actor = req.user!;
    if (
      target.dealerId &&
      !canAccessDealer(actor.dealerId, target.dealerId, actor.role)
    ) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    if (
      !canDeleteTeamUser(
        { sub: actor.sub, role: actor.role, dealerId: actor.dealerId },
        {
          id: target.id,
          role: target.role,
          dealerId: target.dealerId,
          reportsToUserId: target.reportsToUserId,
        },
      )
    ) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    await prisma.$transaction(async (tx) => {
      await tx.notification.deleteMany({ where: { userId: id } });
      await tx.user.delete({ where: { id } });
    });

    await writeAuditEvent({
      dealerId: target.dealerId,
      actorUserId: actor.sub,
      action: "user_deleted",
      entityType: "User",
      entityId: id,
      payload: { role: target.role, username: target.username },
    });

    return { ok: true };
  });

  app.post("/v1/users/bulk", { preHandler: authPreHandler }, async (req, reply) => {
    if (!canAccessTeamUsersApi(req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const body = z
      .object({
        users: z.array(createUserSchema).min(1).max(50),
      })
      .parse(req.body);

    const created: unknown[] = [];
    const errors: { username: string; error: string }[] = [];

    for (const u of body.users) {
      try {
        const res = await app.inject({
          method: "POST",
          url: "/v1/users",
          headers: { authorization: req.headers.authorization ?? "" },
          payload: u,
        });
        if (res.statusCode >= 400) {
          errors.push({ username: u.username, error: res.body });
        } else {
          created.push(JSON.parse(res.body));
        }
      } catch (e) {
        errors.push({ username: u.username, error: String(e) });
      }
    }

    return { created, errors, ok: errors.length === 0 };
  });
}
