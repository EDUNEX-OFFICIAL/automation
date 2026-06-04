import { createPrisma } from "../src/index.js";
import { hashPassword } from "@gdms/auth";

const prisma = createPrisma();

function internalEmail(username: string): string {
  return `${username.toLowerCase()}@gdms.internal`;
}

async function upsertUser(input: {
  username: string;
  password: string;
  role: "SUPER_ADMIN" | "DEALER_ADMIN" | "TEAM_LEADER" | "SALES_CONSULTANT";
  dealerId?: string | null;
  reportsToUserId?: string | null;
  teamType?: "DIGITAL" | "FIELD" | null;
}): Promise<{ id: string; username: string }> {
  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.upsert({
    where: { username: input.username },
    create: {
      username: input.username,
      email: internalEmail(input.username),
      passwordHash,
      role: input.role,
      dealerId: input.dealerId ?? null,
      reportsToUserId: input.reportsToUserId ?? null,
      teamType: input.teamType ?? null,
      isActive: true,
    },
    update: {
      passwordHash,
      role: input.role,
      dealerId: input.dealerId ?? null,
      reportsToUserId: input.reportsToUserId ?? null,
      teamType: input.teamType ?? null,
      isActive: true,
    },
    select: { id: true, username: true },
  });
  return user;
}

async function main(): Promise<void> {
  let dealer = await prisma.dealer.findFirst({ where: { name: "Dealer 1" } });
  if (!dealer) {
    dealer = await prisma.dealer.create({
      data: {
        name: "Dealer 1",
        isActive: true,
        maxTeamLeaders: 10,
        maxSalesConsultants: 50,
      },
    });
  } else {
    dealer = await prisma.dealer.update({
      where: { id: dealer.id },
      data: {
        isActive: true,
        maxTeamLeaders: 10,
        maxSalesConsultants: 50,
      },
    });
  }

  await upsertUser({ username: "super", password: "super123", role: "SUPER_ADMIN" });

  await upsertUser({
    username: "admin1",
    password: "admin1",
    role: "DEALER_ADMIN",
    dealerId: dealer.id,
  });

  const tl1 = await upsertUser({
    username: "1tl1",
    password: "1tl1",
    role: "TEAM_LEADER",
    dealerId: dealer.id,
    teamType: "DIGITAL",
  });

  const tl2 = await upsertUser({
    username: "1tl2",
    password: "1tl2",
    role: "TEAM_LEADER",
    dealerId: dealer.id,
    teamType: "FIELD",
  });

  await upsertUser({
    username: "1sc1",
    password: "1sc1",
    role: "SALES_CONSULTANT",
    dealerId: dealer.id,
    reportsToUserId: tl1.id,
  });

  await upsertUser({
    username: "1sc2",
    password: "1sc2",
    role: "SALES_CONSULTANT",
    dealerId: dealer.id,
    reportsToUserId: tl1.id,
  });

  await upsertUser({
    username: "2sc1",
    password: "2sc1",
    role: "SALES_CONSULTANT",
    dealerId: dealer.id,
    reportsToUserId: tl2.id,
  });

  console.log("Seed OK — login with username + password:");
  console.log("  super / super123 (Super Admin)");
  console.log("  admin1 / admin1 (Dealer Admin)");
  console.log("  1tl1 / 1tl1, 1tl2 / 1tl2 (Team Leaders)");
  console.log("  1sc1 / 1sc1, 1sc2 / 1sc2 under 1tl1; 2sc1 / 2sc1 under 1tl2");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
