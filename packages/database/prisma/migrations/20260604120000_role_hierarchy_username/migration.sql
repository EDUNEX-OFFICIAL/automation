-- Role hierarchy + username login

ALTER TABLE "Dealer" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Dealer" ADD COLUMN IF NOT EXISTS "maxTeamLeaders" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "Dealer" ADD COLUMN IF NOT EXISTS "maxSalesConsultants" INTEGER NOT NULL DEFAULT 50;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "username" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "reportsToUserId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;

UPDATE "User" SET "username" = split_part("email", '@', 1) WHERE "username" IS NULL;

ALTER TABLE "User" ALTER COLUMN "username" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");

ALTER TABLE "WorkflowRun" ADD COLUMN IF NOT EXISTS "startedByUserId" TEXT;

CREATE TYPE "UserRole_new" AS ENUM ('SUPER_ADMIN', 'DEALER_ADMIN', 'TEAM_LEADER', 'SALES_CONSULTANT');

ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;

ALTER TABLE "User" ALTER COLUMN "role" TYPE "UserRole_new" USING (
  CASE "role"::text
    WHEN 'DEALER' THEN 'DEALER_ADMIN'::"UserRole_new"
    WHEN 'USER' THEN 'TEAM_LEADER'::"UserRole_new"
    ELSE "role"::text::"UserRole_new"
  END
);

DROP TYPE "UserRole";

ALTER TYPE "UserRole_new" RENAME TO "UserRole";

ALTER TABLE "User" ADD CONSTRAINT "User_reportsToUserId_fkey"
  FOREIGN KEY ("reportsToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "User_dealerId_role_idx" ON "User"("dealerId", "role");
CREATE INDEX IF NOT EXISTS "User_reportsToUserId_idx" ON "User"("reportsToUserId");
