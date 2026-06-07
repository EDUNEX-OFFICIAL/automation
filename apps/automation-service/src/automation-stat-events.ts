import type { PrismaClient } from "@gdms/database";
import {
  resolveTeamLeaderUserId,
  resolveScUserIdFromLabel,
  salesConsultantGdmsLabel,
} from "./consultant-rotation.js";

export type RecordAutomationStatInput = {
  dealerId: string;
  workflowRunId: string;
  operation: "enquiry_transfer" | "follow_up_skip" | "lost_inquiry";
  startedByUserId: string;
  salesConsultantLabel: string;
  /** Optional pre-resolved SC user id (enquiry transfer). */
  salesConsultantUserId?: string | null;
  teamLeaderUserId?: string | null;
};

export async function recordAutomationStatEvent(
  prisma: PrismaClient,
  input: RecordAutomationStatInput,
): Promise<void> {
  const label = input.salesConsultantLabel.trim();
  if (!label) return;

  let teamLeaderUserId = input.teamLeaderUserId ?? null;
  if (!teamLeaderUserId) {
    try {
      teamLeaderUserId = await resolveTeamLeaderUserId(prisma, input.startedByUserId);
    } catch {
      teamLeaderUserId = null;
    }
  }

  let salesConsultantUserId = input.salesConsultantUserId ?? null;
  if (!salesConsultantUserId && teamLeaderUserId) {
    salesConsultantUserId = await resolveScUserIdFromLabel(
      prisma,
      input.dealerId,
      teamLeaderUserId,
      label,
    );
  }
  if (!salesConsultantUserId) {
    salesConsultantUserId = await resolveScUserIdFromLabel(
      prisma,
      input.dealerId,
      null,
      label,
    );
  }

  if (salesConsultantUserId) {
    const sc = await prisma.user.findUnique({
      where: { id: salesConsultantUserId },
      select: { role: true },
    });
    if (sc?.role !== "SALES_CONSULTANT") {
      salesConsultantUserId = null;
    }
  }

  await prisma.automationStatEvent.create({
    data: {
      dealerId: input.dealerId,
      workflowRunId: input.workflowRunId,
      operation: input.operation,
      startedByUserId: input.startedByUserId,
      teamLeaderUserId,
      salesConsultantUserId,
      salesConsultantLabel: label,
    },
  });
}

export { salesConsultantGdmsLabel };
