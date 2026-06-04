import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authPreHandler } from "../lib/auth-pre.js";
import { prisma } from "../prisma.js";
import {
  encryptSecret,
  fingerprintUsername,
  maskUsername,
  canEditOwnGdmsSecrets,
  canEditTeamGdmsSecrets,
} from "@gdms/auth";
import { looksLikeGdmsCookieToken, parseGdmsBootstrapInput } from "@gdms/shared";
import { env } from "../config.js";
import { decryptGdmsUsername } from "../lib/gdms-credentials.js";
import { setUserGdmsBootstrapCookies } from "../redis.js";

export type GdmsAccountSummary = {
  userId: string;
  username: string;
  role: string;
  dealerId: string | null;
  dealerName?: string;
  configured: boolean;
  usernameMasked?: string;
  updatedAt?: string;
  lastVerifiedAt?: string | null;
};

function summarizeRow(
  user: {
    id: string;
    username: string;
    role: string;
    dealerId: string | null;
    dealer?: { name: string } | null;
  },
  acc: {
    usernameCipher: string;
    updatedAt: Date;
    lastVerifiedAt: Date | null;
  } | null,
): GdmsAccountSummary {
  const dealerName = user.dealer?.name;
  if (!acc) {
    return {
      userId: user.id,
      username: user.username,
      role: user.role,
      dealerId: user.dealerId,
      dealerName,
      configured: false,
    };
  }
  let usernameMasked = "Saved";
  try {
    usernameMasked = maskUsername(decryptGdmsUsername(acc.usernameCipher));
  } catch {
    /* corrupt */
  }
  return {
    userId: user.id,
    username: user.username,
    role: user.role,
    dealerId: user.dealerId,
    dealerName,
    configured: true,
    usernameMasked,
    updatedAt: acc.updatedAt.toISOString(),
    lastVerifiedAt: acc.lastVerifiedAt?.toISOString() ?? null,
  };
}

async function assertCanEditTargetUser(
  actor: { sub: string; role: string; dealerId: string | null },
  targetUserId: string,
): Promise<
  | { ok: true; target: { id: string; dealerId: string | null; role: string } }
  | { ok: false; status: number; error: string }
> {
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, dealerId: true, role: true },
  });
  if (!target) return { ok: false, status: 404, error: "User not found" };
  if (target.role !== "TEAM_LEADER" && target.role !== "SALES_CONSULTANT") {
    return { ok: false, status: 400, error: "GDMS credentials are only for Team Leaders and Sales Consultants" };
  }
  if (actor.role === "DEALER_ADMIN") {
    if (!target.dealerId || target.dealerId !== actor.dealerId) {
      return { ok: false, status: 403, error: "Forbidden" };
    }
    return { ok: true, target };
  }
  if (canEditOwnGdmsSecrets(actor.role as "TEAM_LEADER" | "SALES_CONSULTANT" | "DEALER_ADMIN" | "SUPER_ADMIN")) {
    if (targetUserId !== actor.sub) {
      return { ok: false, status: 403, error: "Forbidden" };
    }
    return { ok: true, target };
  }
  return { ok: false, status: 403, error: "Forbidden" };
}

const upsertSchema = z.object({
  username: z.string().trim().min(1, "username required"),
  password: z.string().trim().min(1, "password required"),
  userId: z.string().optional(),
});

export async function registerGdmsRoutes(app: FastifyInstance): Promise<void> {
  app.put("/v1/gdms-account", { preHandler: authPreHandler }, async (req, reply) => {
    const body = upsertSchema.parse(req.body);
    const targetUserId = body.userId ?? req.user!.sub;
    const gate = await assertCanEditTargetUser(req.user!, targetUserId);
    if (!gate.ok) return reply.code(gate.status).send({ error: gate.error });

    const uPayload = encryptSecret(body.username, env.CREDENTIALS_MASTER_KEY);
    const pPayload = encryptSecret(body.password, env.CREDENTIALS_MASTER_KEY);
    const account = await prisma.gdmsAccount.upsert({
      where: { userId: targetUserId },
      create: {
        userId: targetUserId,
        usernameCipher: JSON.stringify(uPayload),
        passwordCipher: JSON.stringify(pPayload),
        usernameFingerprint: fingerprintUsername(body.username),
        keyVersion: uPayload.keyVersion,
      },
      update: {
        usernameCipher: JSON.stringify(uPayload),
        passwordCipher: JSON.stringify(pPayload),
        usernameFingerprint: fingerprintUsername(body.username),
        keyVersion: uPayload.keyVersion,
        lastVerifiedAt: null,
      },
    });

    const user = await prisma.user.findUnique({
      where: { id: targetUserId },
      include: { dealer: { select: { name: true } } },
    });
    if (!user) return reply.code(404).send({ error: "User not found" });
    return { id: account.id, ...summarizeRow(user, account) };
  });

  /** Team roster GDMS status (dealer admin) or self (TL/SC). */
  app.get("/v1/gdms-accounts", { preHandler: authPreHandler }, async (req, reply) => {
    const actor = req.user!;
    if (canEditTeamGdmsSecrets(actor.role)) {
      if (!actor.dealerId) return [];
      const users = await prisma.user.findMany({
        where: {
          dealerId: actor.dealerId,
          role: { in: ["TEAM_LEADER", "SALES_CONSULTANT"] },
        },
        include: {
          dealer: { select: { name: true } },
          gdmsAccount: true,
        },
        orderBy: [{ role: "asc" }, { username: "asc" }],
      });
      return users.map((u) => summarizeRow(u, u.gdmsAccount));
    }
    if (canEditOwnGdmsSecrets(actor.role)) {
      const u = await prisma.user.findUnique({
        where: { id: actor.sub },
        include: { dealer: { select: { name: true } }, gdmsAccount: true },
      });
      if (!u) return reply.code(404).send({ error: "Not found" });
      return [summarizeRow(u, u.gdmsAccount)];
    }
    return reply.code(403).send({ error: "Forbidden" });
  });

  app.get("/v1/gdms-account", { preHandler: authPreHandler }, async (req, reply) => {
    const q = req.query as { userId?: string };
    const targetUserId = q.userId ?? req.user!.sub;
    const gate = await assertCanEditTargetUser(req.user!, targetUserId);
    if (!gate.ok) return reply.code(gate.status).send({ error: gate.error });

    const user = await prisma.user.findUnique({
      where: { id: targetUserId },
      include: { dealer: { select: { name: true } }, gdmsAccount: true },
    });
    if (!user) return reply.code(404).send({ error: "Not found" });
    return summarizeRow(user, user.gdmsAccount);
  });

  app.put("/v1/gdms/login-token", { preHandler: authPreHandler }, async (req, reply) => {
    const body = z
      .object({
        userId: z.string().optional(),
        token: z.string().min(20),
      })
      .parse(req.body);
    const targetUserId = body.userId ?? req.user!.sub;
    const gate = await assertCanEditTargetUser(req.user!, targetUserId);
    if (!gate.ok) return reply.code(gate.status).send({ error: gate.error });

    if (!looksLikeGdmsCookieToken(body.token)) {
      return reply.code(400).send({
        error:
          "This looks like a Session ID (Run ID), not a GDMS cookie. Use Start from saved session for Run ID, or paste BNES_JSESSIONID from Chrome DevTools.",
      });
    }
    let cookies;
    try {
      cookies = parseGdmsBootstrapInput(body.token);
    } catch {
      return reply.code(400).send({ error: "Invalid cookie token or JSON." });
    }
    if (cookies.length === 0) {
      return reply.code(400).send({ error: "No cookies parsed from token." });
    }
    await setUserGdmsBootstrapCookies(targetUserId, JSON.stringify(cookies));
    return { ok: true, message: "GDMS login token saved for this user." };
  });
}
