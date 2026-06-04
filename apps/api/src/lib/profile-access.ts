import { canEditUserProfile, type Role } from "@gdms/auth";
import { prisma } from "../prisma.js";

export async function assertProfileEditAccess(
  actor: { sub: string; role: Role; dealerId: string | null },
  targetUserId: string,
): Promise<
  | {
      ok: true;
      target: {
        id: string;
        username: string;
        displayName: string | null;
        avatarUrl: string | null;
        role: Role;
        dealerId: string | null;
        reportsToUserId: string | null;
        email: string;
      };
    }
  | { ok: false; status: number; error: string }
> {
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
      role: true,
      dealerId: true,
      reportsToUserId: true,
      email: true,
    },
  });
  if (!target) return { ok: false, status: 404, error: "User not found" };
  if (
    !canEditUserProfile(actor, {
      id: target.id,
      role: target.role as Role,
      dealerId: target.dealerId,
      reportsToUserId: target.reportsToUserId,
    })
  ) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  return { ok: true, target: { ...target, role: target.role as Role } };
}
