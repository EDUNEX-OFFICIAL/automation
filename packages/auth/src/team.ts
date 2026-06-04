export type TeamType = "DIGITAL" | "FIELD";

export const TEAM_TYPE_LABELS: Record<TeamType, string> = {
  DIGITAL: "Digital team",
  FIELD: "Field team",
};

/** Enquiry transfer automation is only for digital team (TL + their SCs). */
export function canRunEnquiryTransfer(teamType: TeamType | null | undefined): boolean {
  return teamType === "DIGITAL";
}
