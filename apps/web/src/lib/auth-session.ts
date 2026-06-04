import { getApiUrl } from "@/lib/api";
import { useAuthStore, type UserInfo } from "@/stores/auth-store";

export async function fetchSetupStatus(): Promise<{ registrationOpen: boolean }> {
  const res = await fetch(`${getApiUrl()}/v1/auth/setup-status`);
  if (!res.ok) return { registrationOpen: false };
  return res.json() as Promise<{ registrationOpen: boolean }>;
}

export async function signOut(): Promise<void> {
  try {
    await fetch(`${getApiUrl()}/v1/auth/logout`, { method: "POST", credentials: "include" });
  } catch {
    /* offline */
  }
  useAuthStore.getState().logout();
}

export async function validateSession(accessToken: string): Promise<UserInfo | null> {
  const fetchMe = async (tok: string): Promise<Response> => {
    return fetch(`${getApiUrl()}/v1/me`, {
      headers: { Authorization: `Bearer ${tok}` },
      credentials: "include",
    });
  };

  let res = await fetchMe(accessToken);
  if (res.status === 401) {
    const refreshRes = await fetch(`${getApiUrl()}/v1/auth/refresh`, {
      method: "POST",
      credentials: "include",
    });
    if (!refreshRes.ok) return null;
    const data = (await refreshRes.json()) as { accessToken: string };
    const prev = useAuthStore.getState().user;
    if (prev) useAuthStore.getState().setAuth(data.accessToken, prev);
    else useAuthStore.getState().setAccessToken(data.accessToken);
    res = await fetchMe(data.accessToken);
  }
  if (!res.ok) return null;
  const raw = (await res.json()) as UserInfo;
  return {
    id: raw.id,
    username: raw.username,
    email: raw.email,
    role: raw.role,
    dealerId: raw.dealerId,
    displayName: raw.displayName ?? null,
    displayLabel: raw.displayLabel ?? (raw.displayName?.trim() || raw.username),
    avatarUrl: raw.avatarUrl ?? null,
    teamType: raw.teamType ?? null,
    effectiveTeamType: raw.effectiveTeamType ?? null,
    canRunEnquiryTransfer: raw.canRunEnquiryTransfer,
  };
}
