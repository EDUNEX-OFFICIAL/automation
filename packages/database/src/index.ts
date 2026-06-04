export { Prisma, PrismaClient, UserRole } from "../generated/prisma-client/index.js";
export type {
  LeadCategory,
  TeamType,
  User,
  WorkflowRun,
  WorkflowRunStatus,
} from "../generated/prisma-client/index.js";

import { PrismaClient } from "../generated/prisma-client/index.js";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function createPrisma(): PrismaClient {
  if (globalForPrisma.prisma) return globalForPrisma.prisma;
  const prisma = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
  if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
  return prisma;
}
