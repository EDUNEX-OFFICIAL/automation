import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authPreHandler } from "../lib/auth-pre.js";
import { prisma } from "../prisma.js";
import { hashPassword, canManageUsers, canAccessDealer } from "@gdms/auth";
import type { UserRole } from "@prisma/client";

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["SUPER_ADMIN", "DEALER", "USER"]),
  dealerId: z.string().optional(),
});

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/users", { preHandler: authPreHandler }, async (req, reply) => {
    if (!canManageUsers(req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (req.user!.role === "SUPER_ADMIN") {
      return prisma.user.findMany({ select: { id: true, email: true, role: true, dealerId: true } });
    }
    if (!req.user!.dealerId) return [];
    return prisma.user.findMany({
      where: { dealerId: req.user!.dealerId },
      select: { id: true, email: true, role: true, dealerId: true },
    });
  });

  app.post("/v1/users", { preHandler: authPreHandler }, async (req, reply) => {
    if (!canManageUsers(req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const body = createUserSchema.parse(req.body);
    let dealerId = body.dealerId ?? null;
    if (req.user!.role === "DEALER") {
      dealerId = req.user!.dealerId;
    }
    if (body.role !== "SUPER_ADMIN" && !dealerId) {
      return reply.code(400).send({ error: "dealerId required" });
    }
    if (dealerId && !canAccessDealer(req.user!.dealerId, dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (body.role === "SUPER_ADMIN" && req.user!.role !== "SUPER_ADMIN") {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const passwordHash = await hashPassword(body.password);
    const role = body.role as UserRole;
    const user = await prisma.user.create({
      data: {
        email: body.email,
        passwordHash,
        role,
        dealerId: body.role === "SUPER_ADMIN" ? null : dealerId,
      },
      select: { id: true, email: true, role: true, dealerId: true },
    });
    return user;
  });
}
