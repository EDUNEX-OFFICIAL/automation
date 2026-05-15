import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** Embedded preview / iframe mein `localStorage` SecurityError → persist poora attach nahi hota; memory fallback. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => Array.from(m.keys())[i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  } as Storage;
}

function webLocalStorage(): Storage {
  if (typeof window === "undefined") return memoryStorage();
  try {
    const s = window.localStorage;
    if (!s) return memoryStorage();
    s.setItem("__gdms_ls_probe", "1");
    s.removeItem("__gdms_ls_probe");
    return s;
  } catch {
    return memoryStorage();
  }
}

export type UserInfo = {
  id: string;
  email: string;
  role: string;
  dealerId: string | null;
};

type AuthState = {
  accessToken: string | null;
  user: UserInfo | null;
  setAuth: (accessToken: string, user: UserInfo) => void;
  /** After silent refresh — same user, new access JWT */
  setAccessToken: (accessToken: string) => void;
  /** Repair partial persisted state where token exists but user is missing. */
  syncUserFromApi: (user: UserInfo) => void;
  logout: () => void;
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      user: null,
      setAuth: (accessToken, user) => set({ accessToken, user }),
      setAccessToken: (accessToken) => set({ accessToken }),
      syncUserFromApi: (user) => set({ user }),
      logout: () => set({ accessToken: null, user: null }),
    }),
    {
      name: "gdms-auth",
      storage: createJSONStorage(webLocalStorage),
      partialize: (state) => ({ accessToken: state.accessToken, user: state.user }),
      /** Late rehydrate purana khali snapshot na aaye; live memory (abhi login) ko precedence. */
      merge: (persisted, current) => {
        const p = persisted as Partial<Pick<AuthState, "accessToken" | "user">> | undefined;
        return {
          ...current,
          accessToken: current.accessToken ?? p?.accessToken ?? null,
          user: current.user ?? p?.user ?? null,
        };
      },
    },
  ),
);
