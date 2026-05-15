-- AlterTable
ALTER TABLE "AiCall" ADD COLUMN "lastCallPhase" TEXT;
ALTER TABLE "AiCall" ADD COLUMN "callEndedAt" TIMESTAMP(3);
