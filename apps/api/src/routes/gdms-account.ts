import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authPreHandler } from "../lib/auth-pre.js";
import { prisma } from "../prisma.js";
import {
  decryptSecret,
  encryptSecret,
  fingerprintUsername,
  maskUsername,
  type EncryptedPayload,
  canEditGdmsSecrets,
  canAccessDealer,
} from "@gdms/auth";
import { looksLikeGdmsCookieToken, parseGdmsBootstrapInput } from "@gdms/shared";
import { env } from "../config.js";
import { setDealerGdmsBootstrapCookies } from "../redis.js";

type GdmsAccountSummary = {
  dealerId: string;
  dealerName: string;
  configured: boolean;
  usernameMasked?: string;
  updatedAt?: string;
  lastVerifiedAt?: string | null;
};

function summarizeGdmsAccount(
  dealer: { id: string; name: string },
  acc: {
    usernameCipher: string;
    updatedAt: Date;
    lastVerifiedAt: Date | null;
  } | null,
): GdmsAccountSummary {
  if (!acc) {
    return { dealerId: dealer.id, dealerName: dealer.name, configured: false };
  }
  let usernameMasked = "Saved";
  try {
    const payload = JSON.parse(acc.usernameCipher) as EncryptedPayload;
    usernameMasked = maskUsername(decryptSecret(payload, env.CREDENTIALS_MASTER_KEY));
  } catch {
    /* corrupt row — still configured */
  }
  return {
    dealerId: dealer.id,
    dealerName: dealer.name,
    configured: true,
    usernameMasked,
    updatedAt: acc.updatedAt.toISOString(),
    lastVerifiedAt: acc.lastVerifiedAt?.toISOString() ?? null,
  };
}

const upsertSchema = z.object({
  username: z.string().trim().min(1, "username required"),
  password: z.string().trim().min(1, "password required"),
  dealerId: z.string().min(1),
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
    const dealer = await prisma.dealer.findUnique({ where: { id: account.dealerId } });
    const summary = summarizeGdmsAccount(
      dealer ?? { id: account.dealerId, name: "Dealer" },
      account,
    );
    return { id: account.id, ...summary };
  });

  app.get("/v1/gdms-accounts", { preHandler: authPreHandler }, async (req) => {
    const user = req.user!;
    let dealers: { id: string; name: string }[];
    if (user.role === "SUPER_ADMIN") {
      dealers = await prisma.dealer.findMany({ orderBy: { name: "asc" } });
    } else if (user.dealerId) {
      const d = await prisma.dealer.findUnique({ where: { id: user.dealerId } });
      dealers = d ? [d] : [];
    } else {
      dealers = [];
    }
    const accounts = await prisma.gdmsAccount.findMany({
      where: { dealerId: { in: dealers.map((d) => d.id) } },
    });
    const byDealer = new Map(accounts.map((a) => [a.dealerId, a]));
    return dealers.map((d) => summarizeGdmsAccount(d, byDealer.get(d.id) ?? null));
  });

  app.get("/v1/gdms-account", { preHandler: authPreHandler }, async (req, reply) => {
    const dealerId =
      (req.query as { dealerId?: string }).dealerId ?? req.user!.dealerId ?? undefined;
    if (!dealerId) return reply.code(400).send({ error: "dealerId required" });
    if (!canAccessDealer(req.user!.dealerId, dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const dealer = await prisma.dealer.findUnique({ where: { id: dealerId } });
    if (!dealer) return reply.code(404).send({ error: "Dealer not found" });
    const acc = await prisma.gdmsAccount.findUnique({ where: { dealerId } });
    return summarizeGdmsAccount(dealer, acc);
  });

  app.put("/v1/gdms/login-token", { preHandler: authPreHandler }, async (req, reply) => {
    const body = z
      .object({
        dealerId: z.string().min(1),
        token: z.string().min(20),
      })
      .parse(req.body);
    if (!canAccessDealer(req.user!.dealerId, body.dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
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
    await setDealerGdmsBootstrapCookies(body.dealerId, JSON.stringify(cookies));
    return { ok: true, message: "GDMS login token saved for this dealer." };
  });
}
