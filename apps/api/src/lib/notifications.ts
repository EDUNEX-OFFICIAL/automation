import type { Prisma } from "@gdms/database";
import { prisma } from "../prisma.js";
import { getIo } from "../socket.js";

export async function notifyUser(input: {
  userId: string;
  type: string;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const row = await prisma.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      payload: (input.payload ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
  getIo().to(`user:${input.userId}`).emit("notification", {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  });
}

/** Notify all active dealer admins for a dealer. */
export async function notifyDealerAdmins(
  dealerId: string,
  input: Omit<Parameters<typeof notifyUser>[0], "userId">,
): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { dealerId, role: "DEALER_ADMIN", isActive: true },
    select: { id: true },
  });
  await Promise.all(admins.map((a) => notifyUser({ ...input, userId: a.id })));
}
