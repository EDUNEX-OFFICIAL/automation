import { create } from "zustand";

export type InquiryRow = {
  id: string;
  phone: string;
  name: string | null;
  category: string;
  status: string | null;
  followUpNotes: string | null;
  /** Set when SUPER_ADMIN loads combined list */
  dealerName?: string;
};

type LeadsState = {
  rows: InquiryRow[];
  setRows: (r: InquiryRow[]) => void;
  /** `/v1/inquiries` query e.g. `?dealerId=x` or `` for super-admin all */
  inquiriesQuerySuffix: string;
  setInquiriesQuerySuffix: (suffix: string) => void;
  /** Latest Android-reported telephony phase per inquiry (Phase 3). */
  callPhaseByInquiryId: Record<string, string>;
  setCallPhase: (inquiryId: string, phase: string) => void;
};

export const useLeadsStore = create<LeadsState>((set) => ({
  rows: [],
  setRows: (rows) => set({ rows }),
  inquiriesQuerySuffix: "",
  setInquiriesQuerySuffix: (inquiriesQuerySuffix) => set({ inquiriesQuerySuffix }),
  callPhaseByInquiryId: {},
  setCallPhase: (inquiryId, phase) =>
    set((s) => ({
      callPhaseByInquiryId: { ...s.callPhaseByInquiryId, [inquiryId]: phase },
    })),
}));
