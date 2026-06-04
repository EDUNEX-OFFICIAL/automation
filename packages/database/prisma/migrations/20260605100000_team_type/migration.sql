-- CreateEnum
CREATE TYPE "TeamType" AS ENUM ('DIGITAL', 'FIELD');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "teamType" "TeamType";

-- Existing team leaders default to digital (enquiry transfer enabled)
UPDATE "User" SET "teamType" = 'DIGITAL' WHERE "role" = 'TEAM_LEADER' AND "teamType" IS NULL;
