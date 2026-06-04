import { createPrisma, type PrismaClient } from "@gdms/database";

export const prisma: PrismaClient = createPrisma();
