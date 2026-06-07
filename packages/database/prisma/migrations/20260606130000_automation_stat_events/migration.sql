-- CreateEnum
CREATE TYPE "AutomationStatOperation" AS ENUM ('enquiry_transfer', 'follow_up_skip');

-- CreateTable
CREATE TABLE "AutomationStatEvent" (
    "id" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "workflowRunId" TEXT NOT NULL,
    "operation" "AutomationStatOperation" NOT NULL,
    "startedByUserId" TEXT NOT NULL,
    "teamLeaderUserId" TEXT,
    "salesConsultantUserId" TEXT,
    "salesConsultantLabel" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationStatEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutomationStatEvent_dealerId_occurredAt_idx" ON "AutomationStatEvent"("dealerId", "occurredAt");

-- CreateIndex
CREATE INDEX "AutomationStatEvent_dealerId_operation_occurredAt_idx" ON "AutomationStatEvent"("dealerId", "operation", "occurredAt");

-- CreateIndex
CREATE INDEX "AutomationStatEvent_teamLeaderUserId_occurredAt_idx" ON "AutomationStatEvent"("teamLeaderUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "AutomationStatEvent_salesConsultantUserId_occurredAt_idx" ON "AutomationStatEvent"("salesConsultantUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "AutomationStatEvent_startedByUserId_occurredAt_idx" ON "AutomationStatEvent"("startedByUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "AutomationStatEvent_workflowRunId_idx" ON "AutomationStatEvent"("workflowRunId");

-- AddForeignKey
ALTER TABLE "AutomationStatEvent" ADD CONSTRAINT "AutomationStatEvent_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationStatEvent" ADD CONSTRAINT "AutomationStatEvent_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
