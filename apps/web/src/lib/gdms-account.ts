export type GdmsAccountSummary = {
  userId: string;
  username: string;
  role: string;
  dealerId: string | null;
  dealerName?: string;
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

export function roleLabel(role: string): string {
  return role.replace(/_/g, " ");
}
