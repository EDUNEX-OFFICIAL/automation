import type { Prisma } from "@gdms/database";
import { prisma } from "../prisma.js";

export async function writeInquiryLog(
  inquiryId: string,
  type: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  await prisma.inquiryLog.create({
    data: {
      inquiryId,
      type,
      payload: (payload ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
