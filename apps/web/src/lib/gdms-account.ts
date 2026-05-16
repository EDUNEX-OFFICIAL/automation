export type GdmsAccountSummary = {
  dealerId: string;
  dealerName: string;
  configured: boolean;
  usernameMasked?: string;
  updatedAt?: string;
  lastVerifiedAt?: string | null;
};

export function formatGdmsSavedAt(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return "—";
  }
}
