-- AlterTable
ALTER TABLE "DealerAutomationSettings" ADD COLUMN IF NOT EXISTS "ollamaModel" TEXT;
ALTER TABLE "DealerAutomationSettings" ADD COLUMN IF NOT EXISTS "enquiryTransferEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DealerAutomationSettings" ADD COLUMN IF NOT EXISTS "enquiryTransferStartTime" TEXT;
ALTER TABLE "DealerAutomationSettings" ADD COLUMN IF NOT EXISTS "lastScheduledRunId" TEXT;
ALTER TABLE "DealerAutomationSettings" ADD COLUMN IF NOT EXISTS "lastScheduledRunAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AuditEvent" (
    "id" TEXT NOT NULL,
    "dealerId" TEXT,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "readAt" TIMESTAMP(3),
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "WorkflowRunLog" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkflowRunLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AuditEvent_dealerId_createdAt_idx" ON "AuditEvent"("dealerId", "createdAt");
CREATE INDEX IF NOT EXISTS "AuditEvent_actorUserId_createdAt_idx" ON "AuditEvent"("actorUserId", "createdAt");
CREATE INDEX IF NOT EXISTS "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");
CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "WorkflowRunLog_runId_ts_idx" ON "WorkflowRunLog"("runId", "ts");
