import type { Prisma } from "@gdms/database";
import { prisma } from "../prisma.js";

export async function writeAuditEvent(input: {
  dealerId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      dealerId: input.dealerId ?? undefined,
      actorUserId: input.actorUserId ?? undefined,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? undefined,
      payload: (input.payload ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
