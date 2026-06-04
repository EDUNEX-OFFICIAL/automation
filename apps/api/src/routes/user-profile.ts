import type { FastifyInstance } from "fastify";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { hashPassword } from "@gdms/auth";
import { authPreHandler } from "../lib/auth-pre.js";
import { assertProfileEditAccess } from "../lib/profile-access.js";
import { prisma } from "../prisma.js";
import { env } from "../config.js";

function internalEmail(username: string): string {
  return `${username.toLowerCase()}@gdms.internal`;
}

const profilePatchSchema = z.object({
  displayName: z.string().trim().max(80).optional(),
  username: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-zA-Z0-9._-]+$/)
    .optional(),
  password: z.string().min(4).max(128).optional(),
  avatarUrl: z.string().url().max(2048).nullable().optional(),
  clearAvatar: z.boolean().optional(),
});

export const profileSelect = {
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
  createdAt: true,
  updatedAt: true,
  reportsTo: { select: { id: true, username: true, displayName: true } },
} as const;

function toProfileDto(user: {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  email: string;
  role: string;
  dealerId: string | null;
  reportsToUserId: string | null;
  teamType?: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  reportsTo?: { id: string; username: string; displayName: string | null } | null;
}) {
  return {
    ...user,
    displayLabel: user.displayName?.trim() || user.username,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export async function registerUserProfileRoutes(app: FastifyInstance): Promise<void> {
  const uploadsRoot = path.resolve(env.UPLOADS_DIR, "avatars");
  await mkdir(uploadsRoot, { recursive: true }).catch(() => undefined);

  app.get("/v1/users/:id/profile", { preHandler: authPreHandler }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const gate = await assertProfileEditAccess(req.user!, id);
    if (!gate.ok) return reply.code(gate.status).send({ error: gate.error });

    const user = await prisma.user.findUnique({
      where: { id },
      select: profileSelect,
    });
    if (!user) return reply.code(404).send({ error: "Not found" });
    return toProfileDto(user);
  });

  app.patch("/v1/users/:id/profile", { preHandler: authPreHandler }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const gate = await assertProfileEditAccess(req.user!, id);
    if (!gate.ok) return reply.code(gate.status).send({ error: gate.error });

    const body = profilePatchSchema.parse(req.body);
    const data: {
      displayName?: string | null;
      username?: string;
      email?: string;
      passwordHash?: string;
      avatarUrl?: string | null;
      tokenVersion?: { increment: number };
    } = {};

    if (body.displayName !== undefined) {
      data.displayName = body.displayName.length > 0 ? body.displayName : null;
    }
    if (body.username !== undefined && body.username !== gate.target.username) {
      data.username = body.username;
      data.email = internalEmail(body.username);
    }
    if (body.password) {
      data.passwordHash = await hashPassword(body.password);
      if (req.user!.sub === id) {
        data.tokenVersion = { increment: 1 };
      }
    }
    if (body.clearAvatar) {
      data.avatarUrl = null;
    } else if (body.avatarUrl !== undefined) {
      data.avatarUrl = body.avatarUrl;
    }

    try {
      const user = await prisma.user.update({
        where: { id },
        data,
        select: profileSelect,
      });
      return toProfileDto(user);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Unique constraint")) {
        return reply.code(409).send({ error: "Username already taken" });
      }
      throw e;
    }
  });

  app.post("/v1/users/:id/avatar", { preHandler: authPreHandler }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const gate = await assertProfileEditAccess(req.user!, id);
    if (!gate.ok) return reply.code(gate.status).send({ error: gate.error });

    const part = await req.file({ limits: { fileSize: 2 * 1024 * 1024 } });
    if (!part) return reply.code(400).send({ error: "No file uploaded" });

    const mime = part.mimetype;
    if (!mime.startsWith("image/")) {
      return reply.code(400).send({ error: "Only image files are allowed" });
    }
    const ext =
      mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "jpg";
    const filename = `${id}.${ext}`;
    const dest = path.join(uploadsRoot, filename);
    await pipeline(part.file, createWriteStream(dest));

    const avatarUrl = `/uploads/avatars/${filename}`;
    const user = await prisma.user.update({
      where: { id },
      data: { avatarUrl },
      select: profileSelect,
    });
    return toProfileDto(user);
  });
}
