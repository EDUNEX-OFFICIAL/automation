import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authPreHandler } from "../lib/auth-pre.js";
import { prisma } from "../prisma.js";
import { encryptSecret, fingerprintUsername, canEditGdmsSecrets, canAccessDealer } from "@gdms/auth";
import { env } from "../config.js";

const upsertSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  dealerId: z.string(),
});

export async function registerGdmsRoutes(app: FastifyInstance): Promise<void> {
  app.put("/v1/gdms-account", { preHandler: authPreHandler }, async (req, reply) => {
    if (!canEditGdmsSecrets(req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const body = upsertSchema.parse(req.body);
    if (!canAccessDealer(req.user!.dealerId, body.dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const uPayload = encryptSecret(body.username, env.CREDENTIALS_MASTER_KEY);
    const pPayload = encryptSecret(body.password, env.CREDENTIALS_MASTER_KEY);
    const account = await prisma.gdmsAccount.upsert({
      where: { dealerId: body.dealerId },
      create: {
        dealerId: body.dealerId,
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
    return { id: account.id, dealerId: account.dealerId, updatedAt: account.updatedAt };
  });

  app.get("/v1/gdms-account", { preHandler: authPreHandler }, async (req, reply) => {
    const dealerId =
      (req.query as { dealerId?: string }).dealerId ?? req.user!.dealerId ?? undefined;
    if (!dealerId) return reply.code(400).send({ error: "dealerId required" });
    if (!canAccessDealer(req.user!.dealerId, dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const acc = await prisma.gdmsAccount.findUnique({ where: { dealerId } });
    if (!acc) return { configured: false };
    return {
      configured: true,
      usernameFingerprint: acc.usernameFingerprint,
      lastVerifiedAt: acc.lastVerifiedAt,
    };
  });
}
