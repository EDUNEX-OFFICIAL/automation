import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AutomationOperation, AutomationSource, SubSourcesSelection } from "@gdms/shared";

export type SavedAutomationSession = {
  runId: string;
  dealerId: string;
  operation: AutomationOperation;
  sources: AutomationSource[];
  subSources?: SubSourcesSelection;
  savedAt: number;
  /** User submitted OTP for this run — retry/resume should not ask again. */
  otpVerifiedAt?: number;
  /** GDMS home/dashboard was reached for this run. */
  gdmsReadyAt?: number;
};

type AutomationSessionState = {
  byDealer: Record<string, SavedAutomationSession>;
  save: (session: Omit<SavedAutomationSession, "savedAt">) => void;
  markOtpVerified: (dealerId: string) => void;
  markGdmsReady: (dealerId: string) => void;
  clear: (dealerId: string) => void;
  get: (dealerId: string) => SavedAutomationSession | undefined;
};

function webStorage(): Storage {
  if (typeof window === "undefined") {
    return {
      get length() {
        return 0;
      },
      clear: () => undefined,
      getItem: () => null,
      key: () => null,
      removeItem: () => undefined,
      setItem: () => undefined,
    } as Storage;
  }
  try {
    return window.localStorage;
  } catch {
    return {
      get length() {
        return 0;
      },
      clear: () => undefined,
      getItem: () => null,
      key: () => null,
      removeItem: () => undefined,
      setItem: () => undefined,
    } as Storage;
  }
}

export const useAutomationSessionStore = create<AutomationSessionState>()(
  persist(
    (set, get) => ({
      byDealer: {},
      save: (session) =>
        set((s) => ({
          byDealer: {
            ...s.byDealer,
            [session.dealerId]: {
              ...session,
              savedAt: Date.now(),
              otpVerifiedAt: s.byDealer[session.dealerId]?.otpVerifiedAt,
              gdmsReadyAt: s.byDealer[session.dealerId]?.gdmsReadyAt,
            },
          },
        })),
      markOtpVerified: (dealerId) =>
        set((s) => {
          const cur = s.byDealer[dealerId];
          if (!cur) return s;
          return {
            byDealer: {
              ...s.byDealer,
              [dealerId]: { ...cur, otpVerifiedAt: Date.now() },
            },
          };
        }),
      markGdmsReady: (dealerId) =>
        set((s) => {
          const cur = s.byDealer[dealerId];
          if (!cur) return s;
          return {
            byDealer: {
              ...s.byDealer,
              [dealerId]: { ...cur, gdmsReadyAt: Date.now() },
            },
          };
        }),
      clear: (dealerId) =>
        set((s) => {
          const copy = { ...s.byDealer };
          delete copy[dealerId];
          return { byDealer: copy };
        }),
      get: (dealerId) => get().byDealer[dealerId],
    }),
    {
      name: "gdms-automation-session",
      storage: createJSONStorage(() => webStorage()),
      partialize: (state) => ({ byDealer: state.byDealer }),
    },
  ),
);

