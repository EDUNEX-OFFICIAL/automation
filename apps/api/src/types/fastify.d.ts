import "fastify";
import type { AccessTokenPayload } from "@gdms/auth";

declare module "fastify" {
  interface FastifyRequest {
    user?: AccessTokenPayload;
  }
}
