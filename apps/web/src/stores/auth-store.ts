import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { clearLiveStoreOnly } from "@/lib/terminate-live-session";
import type { TeamType } from "@/lib/roles";

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

function safeWebStorageForPersist(): Storage {
  const inner = webLocalStorage();
  return {
    get length() {
      return inner.length;
    },
    clear: () => inner.clear(),
    key: (i) => inner.key(i),
    getItem: (key: string) => {
      try {
        const v = inner.getItem(key);
        if (v == null) return null;
        JSON.parse(v);
        return v;
      } catch {
        try {
          inner.removeItem(key);
        } catch {
          /* ignore */
        }
        return null;
      }
    },
    setItem: (k, v) => inner.setItem(k, v),
    removeItem: (k) => inner.removeItem(k),
  } as Storage;
}

export type UserInfo = {
  id: string;
  username: string;
  email: string;
  role: string;
  dealerId: string | null;
  displayName?: string | null;
  displayLabel?: string;
  avatarUrl?: string | null;
  teamType?: TeamType | null;
  effectiveTeamType?: TeamType | null;
  canRunEnquiryTransfer?: boolean;
};

type AuthState = {
  accessToken: string | null;
  user: UserInfo | null;
  setAuth: (accessToken: string, user: UserInfo) => void;
  setAccessToken: (accessToken: string) => void;
  syncUserFromApi: (user: UserInfo) => void;
  logout: () => void;
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      user: null,
      setAuth: (accessToken, user) => {
        const prevId = useAuthStore.getState().user?.id;
        if (prevId && prevId !== user.id) clearLiveStoreOnly();
        set({ accessToken, user });
      },
      setAccessToken: (accessToken) => set({ accessToken }),
      syncUserFromApi: (user) => {
        const prevId = useAuthStore.getState().user?.id;
        if (prevId && prevId !== user.id) clearLiveStoreOnly();
        set({ user });
      },
      logout: () => {
        clearLiveStoreOnly();
        set({ accessToken: null, user: null });
      },
    }),
    {
      name: "gdms-auth",
      storage: createJSONStorage(() => safeWebStorageForPersist()),
      partialize: (state) => ({ accessToken: state.accessToken, user: state.user }),
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
