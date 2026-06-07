"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarClock, XCircle, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBanner } from "@/components/ui/status-banner";
import { SettingsTabs } from "@/components/settings-tabs";
import {
  LiveSessionTabPanel,
  type WorkflowRunRow,
} from "@/components/live-session-tab-panel";
import { apiFetch } from "@/lib/api";
import { toUserMessage } from "@/lib/user-messages";
import { useAuthStore } from "@/stores/auth-store";
import {
  resumeSavedAutomationSession,
} from "@/lib/saved-automation-session";
import { reconcileLiveRunForCurrentUser } from "@/lib/run-ownership";
import {
  isTerminalRunStatus,
} from "@/lib/terminate-live-session";
import { useAutomationSessionStore } from "@/stores/automation-session-store";
import { useLiveStore } from "@/stores/live-store";

type LiveSessionTabId = "1" | "2" | "3";
type TabOperation = "enquiry_transfer" | "follow_up_skip" | "lost_inquiry";

const LIVE_SESSION_TABS: {
  id: LiveSessionTabId;
  label: string;
  operation: TabOperation;
  workspace: 1 | 2 | 3;
  icon: typeof Zap;
  accent: "primary" | "success" | "warning";
}[] = [
  { id: "1", label: "Enquiry Transfer", operation: "enquiry_transfer", workspace: 1, icon: Zap, accent: "primary" },
  { id: "2", label: "Follow Up Skip", operation: "follow_up_skip", workspace: 2, icon: CalendarClock, accent: "success" },
  { id: "3", label: "Lost Inquiry", operation: "lost_inquiry", workspace: 3, icon: XCircle, accent: "warning" },
];

type InFlightTabsResponse = {
  enquiry_transfer: WorkflowRunRow | null;
  follow_up_skip: WorkflowRunRow | null;
  lost_inquiry: WorkflowRunRow | null;
};

type GdmsVncWorkspaceView = {
  id: number;
  label: string;
  pathPrefix: string;
  url: string;
};

export default function LiveSessionPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = useAuthStore((s) => s.accessToken);
  const userId = useAuthStore((s) => s.user?.id);
  const realtimeConnected = useLiveStore((s) => s.realtimeConnected);

  const [activeTab, setActiveTab] = useState<LiveSessionTabId>("1");
  const [tabRuns, setTabRuns] = useState<InFlightTabsResponse>({
    enquiry_transfer: null,
    follow_up_skip: null,
    lost_inquiry: null,
  });
  const [sessionActiveByRunId, setSessionActiveByRunId] = useState<Record<string, boolean>>({});
  const [vncUrlByWorkspace, setVncUrlByWorkspace] = useState<Record<1 | 2 | 3, string | null>>({
    1: null,
    2: null,
    3: null,
  });
  const [endedRun, setEndedRun] = useState<WorkflowRunRow | null>(null);
  const [resuming, setResuming] = useState(false);
  const [controlNotice, setControlNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!token) router.replace("/login");
  }, [token, router]);

  useEffect(() => {
    if (!token) return;
    void reconcileLiveRunForCurrentUser(token);
  }, [token]);

  /** Open correct tab when arriving from a notification (?runId=). */
  useEffect(() => {
    const runId = searchParams.get("runId");
    if (!runId || !token) return;
    void apiFetch<WorkflowRunRow>(`/v1/workflow-runs/${runId}`, { token })
      .then((run) => {
        const op = run.runParams?.operation;
        const tab = LIVE_SESSION_TABS.find((t) => t.operation === op);
        if (tab) setActiveTab(tab.id);
        if (run.liveLogs?.length) useLiveStore.getState().mergeLogsFromPoll(run.liveLogs, run.id);
      })
      .catch(() => undefined);
  }, [searchParams, token]);

  /** Poll one in-flight run per operation for multi-tab Live session. */
  useEffect(() => {
    if (!token) return;
    let stop = false;

    const poll = (): void => {
      void apiFetch<InFlightTabsResponse>("/v1/workflow-runs/in-flight-tabs", { token })
        .then(async (tabs) => {
          if (stop) return;

          const next: InFlightTabsResponse = {
            enquiry_transfer: tabs?.enquiry_transfer ?? null,
            follow_up_skip: tabs?.follow_up_skip ?? null,
            lost_inquiry: tabs?.lost_inquiry ?? null,
          };
          for (const op of ["enquiry_transfer", "follow_up_skip", "lost_inquiry"] as const) {
            const summary = next[op];
            if (!summary?.id) {
              next[op] = null;
              continue;
            }
            try {
              const full = await apiFetch<WorkflowRunRow>(`/v1/workflow-runs/${summary.id}`, { token });
              if (isTerminalRunStatus(full.status)) {
                next[op] = null;
                continue;
              }
              next[op] = full;
              if (full.liveLogs?.length) {
                useLiveStore.getState().mergeLogsFromPoll(full.liveLogs, full.id);
              }
              if (full.status === "PAUSED_OTP") {
                useLiveStore.getState().openOtp(full.id);
              }
            } catch {
              next[op] = summary;
            }
          }

          setTabRuns(next);

          const runIds = LIVE_SESSION_TABS.map((t) => next[t.operation]?.id).filter(Boolean) as string[];
          useLiveStore.getState().setWatchedRunIds(runIds);

          const sessionChecks = await Promise.all(
            runIds.map(async (id) => {
              try {
                const r = await apiFetch<{ active: boolean; watchdog?: boolean }>(
                  `/v1/workflow-runs/${id}/session-active`,
                  { token },
                );
                return [id, Boolean(r.active || r.watchdog)] as const;
              } catch {
                return [id, false] as const;
              }
            }),
          );
          if (!stop) {
            setSessionActiveByRunId(Object.fromEntries(sessionChecks));
          }

          const vncFetches = await Promise.all(
            LIVE_SESSION_TABS.map(async (tab) => {
              const run = next[tab.operation];
              if (!run?.id) return [tab.workspace, null] as const;
              const sessionOn = sessionChecks.find(([id]) => id === run.id)?.[1] ?? false;
              const status = run.status;
              const needsVnc =
                sessionOn ||
                status === "RUNNING" ||
                status === "PAUSED_OTP" ||
                status === "PAUSED_USER";
              if (!needsVnc) return [tab.workspace, null] as const;
              try {
                const q = new URLSearchParams({ runId: run.id, workspace: String(tab.workspace) });
                const r = await apiFetch<{ enabled: boolean; workspaces?: GdmsVncWorkspaceView[] }>(
                  `/v1/gdms-browser-view?${q.toString()}`,
                  { token },
                );
                const url =
                  r.enabled && r.workspaces?.length
                    ? (r.workspaces.find((w) => w.id === tab.workspace)?.url ??
                      r.workspaces[0]?.url ??
                      null)
                    : null;
                return [tab.workspace, url] as const;
              } catch {
                return [tab.workspace, null] as const;
              }
            }),
          );
          if (!stop) {
            setVncUrlByWorkspace({
              1: vncFetches.find(([w]) => w === 1)?.[1] ?? null,
              2: vncFetches.find(([w]) => w === 2)?.[1] ?? null,
              3: vncFetches.find(([w]) => w === 3)?.[1] ?? null,
            });
          }
        })
        .catch(() => {
          /* keep last state on transient failures */
        });
    };

    poll();
    const t = window.setInterval(poll, 3000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [token]);

  useEffect(() => {
    if (!token || !userId) {
      setEndedRun(null);
      return;
    }
    const anyInFlight = LIVE_SESSION_TABS.some((t) => tabRuns[t.operation]?.id);
    if (anyInFlight) {
      setEndedRun(null);
      return;
    }
    const saved = useAutomationSessionStore.getState().get(userId);
    if (!saved?.runId) {
      setEndedRun(null);
      return;
    }
    void apiFetch<WorkflowRunRow>(`/v1/workflow-runs/${saved.runId}`, { token })
      .then((r) => {
        if (isTerminalRunStatus(r.status) || r.status === "FAILED") {
          setEndedRun(r);
          if (r.liveLogs?.length) useLiveStore.getState().mergeLogsFromPoll(r.liveLogs, r.id);
        } else {
          setEndedRun(null);
        }
      })
      .catch(() => setEndedRun(null));
  }, [token, userId, tabRuns]);

  async function resumeFromSaved(): Promise<void> {
    if (!token || !userId || resuming) return;
    const saved = useAutomationSessionStore.getState().get(userId);
    if (!saved?.runId) return;
    setResuming(true);
    setControlNotice(null);
    try {
      await resumeSavedAutomationSession(token, saved);
      setEndedRun(null);
      useLiveStore.getState().setRun(saved.runId);
    } catch (e) {
      setControlNotice(toUserMessage(e, "generic"));
    } finally {
      setResuming(false);
    }
  }

  function handleRunEnded(operation: TabOperation): void {
    setTabRuns((prev) => ({ ...prev, [operation]: null }));
  }

  if (!token) return null;

  const anyActiveRun = LIVE_SESSION_TABS.some((t) => tabRuns[t.operation]?.id);

  return (
    <>
      {!anyActiveRun && endedRun ? (
        <StatusBanner variant="warning" title="Previous automation ended">
          <p className="font-mono text-xs opacity-90">
            {endedRun.status} · {endedRun.id}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" disabled={resuming} onClick={() => void resumeFromSaved()}>
              {resuming ? "Starting…" : "Resume automation"}
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link href="/operations">Start fresh on Operations</Link>
            </Button>
          </div>
        </StatusBanner>
      ) : null}

      {controlNotice ? (
        <div className="rounded-lg border border-info/25 bg-info/10 px-4 py-2.5 text-sm text-foreground">
          {controlNotice}
        </div>
      ) : null}

      <PageHeader
        title="Live session"
        eyebrow={anyActiveRun ? "Monitoring" : "Idle"}
        actions={
          <SettingsTabs
            variant="premium"
            align="end"
            tabs={LIVE_SESSION_TABS.map(({ id, label, icon, accent }) => ({
              id,
              label,
              icon,
              accent,
            }))}
            active={activeTab}
            onChange={(id) => setActiveTab(id as LiveSessionTabId)}
          />
        }
      />

      {LIVE_SESSION_TABS.map((tab) =>
        tab.id === activeTab ? (
          <LiveSessionTabPanel
            key={tab.id}
            tabLabel={tab.label}
            workspace={tab.workspace}
            operation={tab.operation}
            runRow={tabRuns[tab.operation]}
            sessionActive={
              tabRuns[tab.operation]?.id
                ? Boolean(sessionActiveByRunId[tabRuns[tab.operation]!.id])
                : false
            }
            vncUrl={vncUrlByWorkspace[tab.workspace]}
            token={token}
            userId={userId}
            realtimeConnected={realtimeConnected}
            onRunEnded={() => handleRunEnded(tab.operation)}
          />
        ) : null,
      )}
    </>
  );
}
