/** Brand-aligned chart palette (works in light & dark). */
export const CHART_COLORS = {
  enquiryTransfer: "#1a73e8",
  followUpSkip: "#059669",
  lostInquiry: "#d97706",
  muted: "#94a3b8",
  grid: "hsl(var(--border) / 0.6)",
  tooltipBg: "hsl(var(--card))",
  tooltipBorder: "hsl(var(--border))",
} as const;

export const OPERATION_LABELS = {
  enquiryTransfer: "Enquiry transfer",
  followUpSkip: "Follow up skip",
  lostInquiry: "Lost inquiry",
} as const;
