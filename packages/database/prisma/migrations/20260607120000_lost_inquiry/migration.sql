-- AlterEnum
ALTER TYPE "AutomationStatOperation" ADD VALUE 'lost_inquiry';

-- AlterTable
ALTER TABLE "DealerAutomationSettings" ADD COLUMN IF NOT EXISTS "lostInquiryEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DealerAutomationSettings" ADD COLUMN IF NOT EXISTS "lostInquiryStartTime" TEXT;
