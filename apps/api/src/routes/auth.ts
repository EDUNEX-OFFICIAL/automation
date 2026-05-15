import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
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
  email: z.string().email(),
  password: z.string().min(8),
  dealerName: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const looseLoginBodySchema = z.object({
  email: z.string().optional(),
  password: z.string().optional(),
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

/** Empty-body "open" login: on in all non-production; in production only if AUTH_DEV_OPEN_LOGIN=true. */
function openLoginAllowed(): boolean {
  if (env.NODE_ENV !== "production") return true;
  return env.AUTH_DEV_OPEN_LOGIN;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/auth/register", async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const count = await prisma.user.count();
    if (count > 0) {
      return reply.code(403).send({ error: "Registration disabled" });
    }
    const passwordHash = await hashPassword(body.password);
    const user = await prisma.user.create({
      data: {
        email: body.email,
        passwordHash,
        role: "SUPER_ADMIN",
        dealerId: null,
      },
    });
    const access = signAccessToken(
      { sub: user.id, role: "SUPER_ADMIN", dealerId: null },
      env.JWT_SECRET,
      env.JWT_EXPIRES_IN,
    );
    const refresh = signRefreshToken(
      { sub: user.id, tokenVersion: user.tokenVersion },
      env.REFRESH_TOKEN_SECRET,
      env.REFRESH_EXPIRES_IN,
    );
    void reply.setCookie("refresh", refresh, refreshCookieOpts());
    return {
      accessToken: access,
      user: { id: user.id, email: user.email, role: user.role, dealerId: user.dealerId },
    };
  });

  app.post("/v1/auth/login", async (req, reply) => {
    const loose = looseLoginBodySchema.safeParse(req.body);
    const emailTrim = loose.success ? (loose.data.email?.trim() ?? "") : "";
    const passwordRaw = loose.success ? (loose.data.password ?? "") : "";

    if (openLoginAllowed() && !emailTrim && !passwordRaw) {
      let user = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
      if (!user) {
        const passwordHash = await hashPassword(`open-login-${randomUUID()}`);
        try {
          user = await prisma.user.create({
            data: {
              email: "dev-bootstrap@gdms.local",
              passwordHash,
              role: "SUPER_ADMIN",
              dealerId: null,
            },
          });
        } catch {
          user = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
        }
      }
      if (!user) {
        return reply.code(500).send({ error: "Could not create or load a user for open login." });
      }
      const access = signAccessToken(
        { sub: user.id, role: user.role, dealerId: user.dealerId },
        env.JWT_SECRET,
        env.JWT_EXPIRES_IN,
      );
      const refresh = signRefreshToken(
        { sub: user.id, tokenVersion: user.tokenVersion },
        env.REFRESH_TOKEN_SECRET,
        env.REFRESH_EXPIRES_IN,
      );
      void reply.setCookie("refresh", refresh, refreshCookieOpts());
      return {
        accessToken: access,
        user: { id: user.id, email: user.email, role: user.role, dealerId: user.dealerId },
      };
    }

    if (!emailTrim && !passwordRaw) {
      return reply.code(401).send({ error: "Email and password required (or enable AUTH_DEV_OPEN_LOGIN for empty-body login)." });
    }

    const body = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user) return reply.code(401).send({ error: "Invalid credentials" });
    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) return reply.code(401).send({ error: "Invalid credentials" });
    const access = signAccessToken(
      { sub: user.id, role: user.role, dealerId: user.dealerId },
      env.JWT_SECRET,
      env.JWT_EXPIRES_IN,
    );
    const refresh = signRefreshToken(
      { sub: user.id, tokenVersion: user.tokenVersion },
      env.REFRESH_TOKEN_SECRET,
      env.REFRESH_EXPIRES_IN,
    );
    void reply.setCookie("refresh", refresh, refreshCookieOpts());
    return {
      accessToken: access,
      user: { id: user.id, email: user.email, role: user.role, dealerId: user.dealerId },
    };
  });

  app.post("/v1/auth/refresh", async (req, reply) => {
    const token = req.cookies.refresh;
    if (!token) return reply.code(401).send({ error: "No refresh" });
    try {
      const payload = verifyRefreshToken(token, env.REFRESH_TOKEN_SECRET);
      const user = await prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user || user.tokenVersion !== payload.tokenVersion) {
        return reply.code(401).send({ error: "Invalid refresh" });
      }
      const access = signAccessToken(
        { sub: user.id, role: user.role, dealerId: user.dealerId },
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
