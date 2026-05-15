import { verifyPassword } from "@gdms/auth";
import { prisma } from "../prisma.js";

export async function verifyAndroidSocketAuth(
  deviceId: string,
  socketToken: string,
): Promise<{ id: string; dealerId: string } | null> {
  const dev = await prisma.androidDevice.findUnique({ where: { deviceId } });
  if (!dev?.socketTokenHash || dev.socketTokenHash.length < 20) return null;
  const ok = await verifyPassword(socketToken, dev.socketTokenHash);
  if (!ok) return null;
  return { id: dev.id, dealerId: dev.dealerId };
}
