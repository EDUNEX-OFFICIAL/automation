import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyAccessToken } from "@gdms/auth";
import { env } from "../config.js";

export async function authPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
  const token = header.slice("Bearer ".length);
  try {
    req.user = verifyAccessToken(token, env.JWT_SECRET);
  } catch {
    return reply.code(401).send({ error: "Unauthorized" });
  }
}
