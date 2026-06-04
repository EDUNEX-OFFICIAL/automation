import { apiFetch } from "@/lib/api";
import { clearLiveStoreOnly } from "@/lib/terminate-live-session";
import { useAuthStore } from "@/stores/auth-store";
import { useAutomationSessionStore } from "@/stores/automation-session-store";
import { useLiveStore } from "@/stores/live-store";

type RunOwnerCheck = {
  id: string;
  status: string;
  startedByUserId?: string | null;
};

/** Drop live link if run belongs to another user or is inaccessible. */
export async function reconcileLiveRunForCurrentUser(token: string): Promise<void> {
  const me = useAuthStore.getState().user;
  const runId = useLiveStore.getState().runId;
  if (!me?.id || !runId) return;

  try {
    const run = await apiFetch<RunOwnerCheck>(`/v1/workflow-runs/${encodeURIComponent(runId)}`, {
      token,
    });
    if (run.startedByUserId && run.startedByUserId !== me.id) {
      clearLiveStoreOnly();
      useAutomationSessionStore.getState().clear(me.id);
    }
  } catch {
    clearLiveStoreOnly();
    useAutomationSessionStore.getState().clear(me.id);
  }
}
