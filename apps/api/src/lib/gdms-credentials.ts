import { decryptSecret, type EncryptedPayload } from "@gdms/auth";
import { createPrisma } from "@gdms/database";
import { env } from "../config.js";

const prisma = createPrisma();

export function parseEnc(stored: string): EncryptedPayload {
  return JSON.parse(stored) as EncryptedPayload;
}

export function decryptGdmsUsername(cipherJson: string): string {
  return decryptSecret(parseEnc(cipherJson), env.CREDENTIALS_MASTER_KEY).trim();
}

export async function getGdmsCredentialsForUser(userId: string): Promise<{
  username: string;
  password: string;
} | null> {
  const acc = await prisma.gdmsAccount.findUnique({ where: { userId } });
  if (!acc) return null;
  return {
    username: decryptGdmsUsername(acc.usernameCipher),
    password: decryptSecret(parseEnc(acc.passwordCipher), env.CREDENTIALS_MASTER_KEY).trim(),
  };
}

/** Scheduled runs: first active TL/SC in dealer with saved GDMS credentials. */
export async function resolveGdmsUserIdForDealerAutomation(dealerId: string): Promise<string | null> {
  const row = await prisma.user.findFirst({
    where: {
      dealerId,
      isActive: true,
      role: { in: ["TEAM_LEADER", "SALES_CONSULTANT"] },
      gdmsAccount: { isNot: null },
    },
    orderBy: [{ role: "asc" }, { username: "asc" }],
    select: { id: true },
  });
  return row?.id ?? null;
}
