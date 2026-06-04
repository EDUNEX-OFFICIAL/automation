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
  /** Keyed by app user id — not dealer (multiple TL/SC share a dealer). */
  byUser: Record<string, SavedAutomationSession>;
  save: (userId: string, session: Omit<SavedAutomationSession, "savedAt">) => void;
  markOtpVerified: (userId: string) => void;
  markGdmsReady: (userId: string) => void;
  clear: (userId: string) => void;
  get: (userId: string) => SavedAutomationSession | undefined;
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
      byUser: {},
      save: (userId, session) =>
        set((s) => ({
          byUser: {
            ...s.byUser,
            [userId]: {
              ...session,
              savedAt: Date.now(),
              otpVerifiedAt: s.byUser[userId]?.otpVerifiedAt,
              gdmsReadyAt: s.byUser[userId]?.gdmsReadyAt,
            },
          },
        })),
      markOtpVerified: (userId) =>
        set((s) => {
          const cur = s.byUser[userId];
          if (!cur) return s;
          return {
            byUser: {
              ...s.byUser,
              [userId]: { ...cur, otpVerifiedAt: Date.now() },
            },
          };
        }),
      markGdmsReady: (userId) =>
        set((s) => {
          const cur = s.byUser[userId];
          if (!cur) return s;
          return {
            byUser: {
              ...s.byUser,
              [userId]: { ...cur, gdmsReadyAt: Date.now() },
            },
          };
        }),
      clear: (userId) =>
        set((s) => {
          const copy = { ...s.byUser };
          delete copy[userId];
          return { byUser: copy };
        }),
      get: (userId) => get().byUser[userId],
    }),
    {
      name: "gdms-automation-session-v2",
      storage: createJSONStorage(() => webStorage()),
      partialize: (state) => ({ byUser: state.byUser }),
    },
  ),
);
