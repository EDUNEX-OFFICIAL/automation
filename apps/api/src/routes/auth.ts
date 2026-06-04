import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "@gdms/auth";
import { prisma } from "../prisma.js";
import { env } from "../config.js";

const registerSchema = z.object({
  username: z.string().min(2).max(32).regex(/^[a-zA-Z0-9._-]+$/),
  password: z.string().min(8),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

function refreshCookieOpts() {
  return {
    path: "/" as const,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    maxAge: env.REFRESH_COOKIE_MAX_AGE_SEC,
  };
}

function internalEmail(username: string): string {
  return `${username.toLowerCase()}@gdms.internal`;
}

function userResponse(user: {
  id: string;
  username: string;
  email: string;
  role: string;
  dealerId: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    dealerId: user.dealerId,
    displayName: user.displayName ?? null,
    displayLabel: user.displayName?.trim() || user.username,
    avatarUrl: user.avatarUrl ?? null,
  };
}

async function issueTokens(user: {
  id: string;
  username: string;
  role: string;
  dealerId: string | null;
  tokenVersion: number;
}) {
  const access = signAccessToken(
    {
      sub: user.id,
      role: user.role as "SUPER_ADMIN" | "DEALER_ADMIN" | "TEAM_LEADER" | "SALES_CONSULTANT",
      dealerId: user.dealerId,
      username: user.username,
    },
    env.JWT_SECRET,
    env.JWT_EXPIRES_IN,
  );
  const refresh = signRefreshToken(
    { sub: user.id, tokenVersion: user.tokenVersion },
    env.REFRESH_TOKEN_SECRET,
    env.REFRESH_EXPIRES_IN,
  );
  return { accessToken: access, refresh };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/auth/setup-status", async () => {
    const count = await prisma.user.count();
    return { registrationOpen: count === 0 };
  });

  app.post("/v1/auth/register", async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const count = await prisma.user.count();
    if (count > 0) {
      return reply.code(403).send({ error: "Registration disabled" });
    }
    const passwordHash = await hashPassword(body.password);
    const user = await prisma.user.create({
      data: {
        username: body.username,
        email: internalEmail(body.username),
        passwordHash,
        role: "SUPER_ADMIN",
        dealerId: null,
      },
    });
    const { accessToken, refresh } = await issueTokens(user);
    void reply.setCookie("refresh", refresh, refreshCookieOpts());
    return { accessToken, user: userResponse(user) };
  });

  app.post("/v1/auth/login", async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { username: body.username } });
    if (!user || !user.isActive) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }
    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) return reply.code(401).send({ error: "Invalid credentials" });

    if (user.dealerId) {
      const dealer = await prisma.dealer.findUnique({ where: { id: user.dealerId } });
      if (!dealer?.isActive) {
        return reply.code(403).send({ error: "Dealer account is disabled" });
      }
    }

    const { accessToken, refresh } = await issueTokens(user);
    void reply.setCookie("refresh", refresh, refreshCookieOpts());
    return { accessToken, user: userResponse(user) };
  });

  app.post("/v1/auth/refresh", async (req, reply) => {
    const token = req.cookies.refresh;
    if (!token) return reply.code(401).send({ error: "No refresh" });
    try {
      const payload = verifyRefreshToken(token, env.REFRESH_TOKEN_SECRET);
      const user = await prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user || user.tokenVersion !== payload.tokenVersion || !user.isActive) {
        return reply.code(401).send({ error: "Invalid refresh" });
      }
      const access = signAccessToken(
        {
          sub: user.id,
          role: user.role,
          dealerId: user.dealerId,
          username: user.username,
        },
        env.JWT_SECRET,
        env.JWT_EXPIRES_IN,
      );
      return { accessToken: access };
    } catch {
      return reply.code(401).send({ error: "Invalid refresh" });
    }
  });

  app.post("/v1/auth/logout", async (_req, reply) => {
    void reply.clearCookie("refresh", { path: "/" });
    return { ok: true };
  });
}
