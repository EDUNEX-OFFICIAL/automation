-- CreateTable
CREATE TABLE "DealerAutomationSettings" (
    "id" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "followUpSkipEnabled" BOOLEAN NOT NULL DEFAULT false,
    "followUpSkipStartTime" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealerAutomationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DealerAutomationSettings_dealerId_key" ON "DealerAutomationSettings"("dealerId");

-- AddForeignKey
ALTER TABLE "DealerAutomationSettings" ADD CONSTRAINT "DealerAutomationSettings_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
