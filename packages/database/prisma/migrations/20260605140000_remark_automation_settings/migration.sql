-- Remark configuration for enquiry transfer and follow-up skip
ALTER TABLE "DealerAutomationSettings" ADD COLUMN IF NOT EXISTS "defaultEnquiryRemarkBase" TEXT NOT NULL DEFAULT 'Call Back';
ALTER TABLE "DealerAutomationSettings" ADD COLUMN IF NOT EXISTS "enquiryRemarkRules" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "DealerAutomationSettings" ADD COLUMN IF NOT EXISTS "followUpSkipRemarkBases" JSONB NOT NULL DEFAULT '[]';
