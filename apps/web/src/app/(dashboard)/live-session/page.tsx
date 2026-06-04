"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBanner } from "@/components/ui/status-banner";
import { LiveSessionLogPanel } from "@/components/live-session-log-panel";
import { OtpEntryPanel } from "@/components/otp-entry-panel";
import { RunStatusBadge } from "@/components/run-status-badge";
import { LiveSessionActions } from "@/components/live-session-actions";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { toUserMessage } from "@/lib/user-messages";
import { useAuthStore } from "@/stores/auth-store";
import {
  linkLiveSessionToInFlightRun,
  resumeSavedAutomationSession,
} from "@/lib/saved-automation-session";
import { reconcileLiveRunForCurrentUser } from "@/lib/run-ownership";
import {
  isTerminalRunStatus,
  terminateLiveSessionLocally,
} from "@/lib/terminate-live-session";
import { useAutomationSessionStore } from "@/stores/automation-session-store";
import { useLiveStore } from "@/stores/live-store";

function friendlyRunError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return toUserMessage(raw, "generic");
}

type WorkflowRunRow = {
  id: string;
  status: string;
  currentStep: string | null;
  errorMessage: string | null;
  startedAt: string;
  endedAt: string | null;
  runParams?: { operation?: string } | null;
  liveLogs?: { level: string; message: string; ts: string }[];
};

type GdmsVncWorkspaceView = {
  id: number;
  label: string;
  pathPrefix: string;
  url: string;
};

export default function LiveSessionPage() {
  const router = useRouter();
  const token = useAuthStore((s) => s.accessToken);
  const userId = useAuthStore((s) => s.user?.id);
  const runId = useLiveStore((s) => s.runId);
  const lastStep = useLiveStore((s) => s.lastStep);
  const logs = useLiveStore((s) => s.logs);
  const realtimeConnected = useLiveStore((s) => s.realtimeConnected);
  const workflowDone = useLiveStore((s) => s.workflowDone);

  const [runRow, setRunRow] = useState<WorkflowRunRow | null>(null);
  const [logoutMessage, setLogoutMessage] = useState<string | null>(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [requeuing, setRequeuing] = useState(false);
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [vncWorkspaces, setVncWorkspaces] = useState<GdmsVncWorkspaceView[]>([]);
  const [previewWorkspace, setPreviewWorkspace] = useState<1 | 2>(1);
  const [controlBusy, setControlBusy] = useState<"pause" | "resume" | "stop" | null>(null);
  const [controlNotice, setControlNotice] = useState<string | null>(null);
  const [endedRun, setEndedRun] = useState<WorkflowRunRow | null>(null);
  const [resuming, setResuming] = useState(false);

  useEffect(() => {
    if (!token) router.replace("/login");
  }, [token, router]);

  useEffect(() => {
    if (!token) return;
    void reconcileLiveRunForCurrentUser(token);
  }, [token]);

  useEffect(() => {
    if (!token || !userId || runId) {
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
          if (r.liveLogs?.length) useLiveStore.getState().mergeLogsFromPoll(r.liveLogs);
        } else {
          setEndedRun(null);
        }
      })
      .catch(() => setEndedRun(null));
  }, [token, userId, runId]);

  useEffect(() => {
    if (!token || !runId) {
      setVncWorkspaces([]);
      return;
    }
    const q = new URLSearchParams({ runId });
    if (previewWorkspace === 2) q.set("workspace", "2");
    else q.set("workspace", "1");
    void apiFetch<{ enabled: boolean; workspaces?: GdmsVncWorkspaceView[]; url?: string }>(
      `/v1/gdms-browser-view?${q.toString()}`,
      { token },
    )
      .then((r) => setVncWorkspaces(r.enabled && r.workspaces?.length ? r.workspaces : []))
      .catch(() => setVncWorkspaces([]));
  }, [token, runId, previewWorkspace]);

  const activeRunOperation = runRow?.runParams?.operation ?? runRow?.currentStep ?? "";
  const isFollowUpSkipRun = activeRunOperation === "follow_up_skip";

  useEffect(() => {
    if (activeRunOperation === "follow_up_skip") setPreviewWorkspace(2);
    else if (activeRunOperation === "enquiry_transfer") setPreviewWorkspace(1);
  }, [activeRunOperation, runId]);

  const gdmsBrowserUrl =
    vncWorkspaces.find((w) => w.id === previewWorkspace)?.url ??
    vncWorkspaces[0]?.url ??
    null;

  const sessionHydrated = useAutomationSessionStore.persist?.hasHydrated?.() ?? true;

  useEffect(() => {
    if (!sessionHydrated || !token || !userId) return;

    const linkRun = (): void => {
      if (useLiveStore.getState().runId) return;
      void linkLiveSessionToInFlightRun(token, userId).catch(() => {});
    };

    linkRun();
    const t = window.setInterval(linkRun, 4000);
    return () => window.clearInterval(t);
  }, [sessionHydrated, userId, token]);

  useEffect(() => {
    if (runRow?.status === "PAUSED_OTP" && runId) {
      useLiveStore.getState().openOtp(runId);
    }
  }, [runRow?.status, runId, runRow?.currentStep]);

  const otpPending = useLiveStore((s) => s.otpPending);
  useEffect(() => {
    if ((runRow?.status === "PAUSED_OTP" || otpPending) && runId) {
      useLiveStore.getState().openOtp(runId);
    }
  }, [runRow?.status, otpPending, runId]);

  useEffect(() => {
    if (!token || !runId) {
      setRunRow(null);
      return;
    }
    let stop = false;
    const poll = (): void => {
      void apiFetch<WorkflowRunRow>(`/v1/workflow-runs/${runId}`, { token })
        .then((r) => {
          if (!stop) {
            if (isTerminalRunStatus(r.status)) {
              terminateLiveSessionLocally(userId);
              setRunRow(null);
              setPendingSince(null);
              return;
            }
            setRunRow(r);
            if (r.liveLogs?.length) {
              useLiveStore.getState().mergeLogsFromPoll(r.liveLogs);
            }
            if (r.status === "PENDING") {
              setPendingSince((prev) => prev ?? Date.parse(r.startedAt));
            } else {
              setPendingSince(null);
            }
          }
        })
        .catch(() => {
          if (!stop) setRunRow(null);
        });
    };
    poll();
    const t = window.setInterval(poll, 3000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [token, runId, userId]);

  useEffect(() => {
    if (!token || !runId) {
      setSessionActive(false);
      return;
    }
    let stop = false;
    const poll = (): void => {
      void apiFetch<{ active: boolean; watchdog?: boolean }>(
        `/v1/workflow-runs/${runId}/session-active`,
        { token },
      )
        .then((r) => {
          if (!stop) setSessionActive(Boolean(r.active || r.watchdog));
        })
        .catch(() => {
          if (!stop) setSessionActive(false);
        });
    };
    poll();
    const t = window.setInterval(poll, 3000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [token, runId]);

  async function control(action: "pause" | "resume" | "stop"): Promise<void> {
    if (!token || !runId || controlBusy) return;
    if (action === "stop" && !window.confirm("Stop this automation run? The browser session will end.")) {
      return;
    }
    setControlBusy(action);
    setControlNotice(null);
    try {
      const res = await apiFetch<{ ok: boolean; status?: string }>(
        `/v1/workflow-runs/${runId}/control`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ action }),
        },
      );
      const label =
        action === "pause" ? "Paused." : action === "resume" ? "Resumed." : "Stopped.";
      setControlNotice(label);
      useLiveStore.getState().pushLog({
        level: "info",
        message: label,
        ts: new Date().toISOString(),
      });
      if (action === "stop") {
        terminateLiveSessionLocally(userId);
        setRunRow(null);
        setSessionActive(false);
        setPendingSince(null);
      } else {
        const fresh = await apiFetch<WorkflowRunRow>(`/v1/workflow-runs/${runId}`, { token });
        setRunRow(fresh);
        if (res.status && res.status !== fresh.status) {
          setRunRow({ ...fresh, status: res.status });
        }
      }
    } catch (e) {
      const msg = toUserMessage(e, "generic");
      setControlNotice(`Could not ${action}: ${msg}`);
      useLiveStore.getState().pushLog({
        level: "warn",
        message: `Could not ${action}: ${msg}`,
        ts: new Date().toISOString(),
      });
    } finally {
      setControlBusy(null);
    }
  }

  async function requeueRun(): Promise<void> {
    if (!token || !runId || requeuing) return;
    setRequeuing(true);
    try {
      await apiFetch(`/v1/workflow-runs/${runId}/requeue`, {
        method: "POST",
        token,
        body: JSON.stringify({}),
      });
      useLiveStore.getState().pushLog({
        level: "info",
        message: "Run queued again.",
        ts: new Date().toISOString(),
      });
    } catch (e) {
      useLiveStore.getState().pushLog({
        level: "warn",
        message: toUserMessage(e, "generic"),
        ts: new Date().toISOString(),
      });
    } finally {
      setRequeuing(false);
    }
  }

  async function retryTransfer(): Promise<void> {
    if (!token || !runId || retrying) return;
    setRetrying(true);
    try {
      const endpoint = sessionActive
        ? `/v1/workflow-runs/${runId}/retry-transfer`
        : `/v1/workflow-runs/${runId}/resume-session`;
      await apiFetch(endpoint, {
        method: "POST",
        token,
        body: JSON.stringify({}),
      });
      useLiveStore.getState().pushLog({
        level: "info",
        message: sessionActive ? "Continuing enquiry transfer." : "Resuming saved session.",
        ts: new Date().toISOString(),
      });
    } catch (e) {
      const msg = toUserMessage(e, "generic");
      useLiveStore.getState().pushLog({
        level: "warn",
        message: msg,
        ts: new Date().toISOString(),
      });
    } finally {
      setRetrying(false);
    }
  }

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

  async function gdmsLogout(): Promise<void> {
    if (!token || !runId) return;
    setLogoutMessage(null);
    try {
      await apiFetch(`/v1/workflow-runs/${runId}/gdms-logout`, {
        method: "POST",
        token,
        body: JSON.stringify({}),
      });
      const okMsg = "GDMS sign-out requested.";
      setLogoutMessage(null);
      useLiveStore.getState().pushLog({
        level: "info",
        message: okMsg,
        ts: new Date().toISOString(),
      });
    } catch (e) {
      const msg = toUserMessage(e, "generic");
      setLogoutMessage(msg);
      useLiveStore.getState().pushLog({
        level: "warn",
        message: msg,
        ts: new Date().toISOString(),
      });
    }
  }

  if (!token) return null;

  const runFailed = runRow?.status === "FAILED";
  const runPausedUser = runRow?.status === "PAUSED_USER";
  const runIsActive = runRow?.status === "RUNNING" || runRow?.status === "PAUSED_OTP";
  const runStopped = runRow?.status === "STOPPED";
  const friendlyError = friendlyRunError(runRow?.errorMessage);
  const previewHint = !runId
    ? "No active run."
    : !realtimeConnected
      ? "Connecting…"
      : runStopped
        ? "Remote view ended."
        : runFailed || runPausedUser
          ? friendlyError ?? "Needs attention."
          : runRow?.status === "RUNNING"
            ? gdmsBrowserUrl
              ? "Live noVNC view."
              : "Starting remote view…"
            : runRow?.status === "PENDING"
              ? "Queued…"
              : gdmsBrowserUrl
                ? "noVNC ready."
                : "Waiting for noVNC…";

  const showPostLogin = workflowDone || runRow?.status === "COMPLETED";
  const canContinueWhileRunning =
    runRow?.status === "RUNNING" &&
    (lastStep?.includes("Wait for GDMS dashboard") ||
      logs.some((l) => /still waiting for dashboard/i.test(l.message)));
  const pendingAgeMs =
    runRow?.status === "PENDING" && pendingSince != null ? Date.now() - pendingSince : 0;
  const showRequeue =
    !!runId && runRow?.status === "PENDING" && pendingAgeMs > 20_000 && !requeuing;
  const canRetryTransfer =
    !!runId &&
    !retrying &&
    (runFailed || runPausedUser || canContinueWhileRunning || (sessionActive && runRow?.status === "RUNNING"));
  const retryButtonLabel = !sessionActive
    ? "Resume saved session"
    : runRow?.status === "RUNNING"
      ? isFollowUpSkipRun
        ? "Continue follow-up skip"
        : "Continue transfer"
      : isFollowUpSkipRun
        ? "Retry follow-up skip"
        : "Retry transfer";
  const runStatus = runRow?.status;
  const canPause = !!runId && (runStatus === "RUNNING" || runStatus === "PAUSED_OTP");
  const canResume = !!runId && (runStatus === "PAUSED_USER" || runStatus === "FAILED");
  const canStop =
    !!runId &&
    (runStatus === "PENDING" ||
      runStatus === "RUNNING" ||
      runStatus === "PAUSED_OTP" ||
      runStatus === "PAUSED_USER" ||
      runStatus === "FAILED");
  const pauseDisabledReason =
    runStatus === "PENDING"
      ? "Still queued — use Stop to cancel or wait a few seconds"
      : !canPause
        ? "Only available while automation is running"
        : undefined;
  const resumeDisabledReason = !canResume ? "Available when the run is paused or failed" : undefined;
  const stopDisabledReason = !canStop ? "No active run to stop" : undefined;
  const canGdmsLogout = !!runId && sessionActive;
  const controlBtnDisabledClass =
    "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-35 disabled:grayscale disabled:hover:bg-inherit disabled:hover:text-inherit";

  return (
    <>
      {!runId && endedRun ? (
        <StatusBanner variant="warning" title="Previous automation ended">
          <p className="font-mono text-xs opacity-90">{endedRun.status} · {endedRun.id}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" disabled={resuming} onClick={() => void resumeFromSaved()}>
              {resuming ? "Starting…" : "Resume automation"}
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link href="/dashboard">Start fresh on Dashboard</Link>
            </Button>
          </div>
        </StatusBanner>
      ) : null}

      {showPostLogin && (
        <div className="panel-success">
          <p className="font-medium">GDMS ready</p>
        </div>
      )}

      {(runRow?.status === "PAUSED_OTP" || otpPending) && (
        <OtpEntryPanel variant="card" className="mb-2" />
      )}

      {logoutMessage && (
        <StatusBanner variant="error" title="Could not sign out of GDMS">
          {logoutMessage}
        </StatusBanner>
      )}

      {runRow?.status === "PENDING" && pendingAgeMs > 20_000 ? (
        <StatusBanner variant="warning" title="Still queued" />
      ) : null}

      {controlNotice ? (
        <div className="rounded-lg border border-info/25 bg-info/10 px-4 py-2.5 text-sm text-foreground">
          {controlNotice}
        </div>
      ) : null}

      {friendlyError && runIsActive && sessionActive ? (
        <StatusBanner variant="warning" title="Notice">
          {friendlyError}
        </StatusBanner>
      ) : null}

      {(runFailed || runPausedUser) && friendlyError && !runIsActive && (
        <StatusBanner
          variant="error"
          title={runPausedUser ? "Paused" : "Failed"}
        >
          {friendlyError}
        </StatusBanner>
      )}

      <PageHeader
        title="Live session"
        eyebrow={runId ?? "Monitoring"}
        actions={
          <LiveSessionActions>
            <RunStatusBadge status={runRow?.status} />
          {gdmsBrowserUrl &&
          (sessionActive ||
            runRow?.status === "RUNNING" ||
            runRow?.status === "PAUSED_OTP") ? (
            <Button
              size="sm"
              variant="default"
              className="hidden bg-primary hover:bg-primary/90 md:inline-flex"
              onClick={() => {
                window.open(
                  gdmsBrowserUrl,
                  `gdms-browser-ws${previewWorkspace}`,
                  "width=1600,height=900,menubar=no,toolbar=no",
                );
              }}
            >
              Open GDMS Chrome window
            </Button>
          ) : null}
          {showRequeue ? (
            <Button size="sm" variant="outline" onClick={() => void requeueRun()}>
              {requeuing ? "Working…" : "Retry queue"}
            </Button>
          ) : null}
          {canRetryTransfer ? (
            <Button size="sm" onClick={() => void retryTransfer()}>
              {retrying ? "Working…" : retryButtonLabel}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            title={pauseDisabledReason}
            className={cn(
              controlBtnDisabledClass,
              controlBusy === "pause" && "ring-2 ring-amber-400",
              canPause && !controlBusy && "border-amber-300 hover:bg-amber-50",
            )}
            disabled={!canPause || !!controlBusy}
            onClick={() => void control("pause")}
          >
            {controlBusy === "pause" ? "Pausing…" : "Pause"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            title={resumeDisabledReason}
            className={cn(
              controlBtnDisabledClass,
              controlBusy === "resume" && "ring-2 ring-emerald-400",
              canResume &&
                !controlBusy &&
                "border-emerald-300 hover:bg-emerald-50 dark:border-emerald-600 dark:hover:bg-emerald-950/40",
            )}
            disabled={!canResume || !!controlBusy}
            onClick={() => void control("resume")}
          >
            {controlBusy === "resume" ? "Resuming…" : "Resume"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className={controlBtnDisabledClass}
            disabled={!canGdmsLogout}
            onClick={() => void gdmsLogout()}
          >
            Logout GDMS
          </Button>
          <Button
            size="sm"
            variant="outline"
            title={stopDisabledReason}
            className={cn(
              controlBtnDisabledClass,
              controlBusy === "stop" && "ring-2 ring-red-400",
              canStop &&
                !controlBusy &&
                "border-red-300 text-red-900 hover:bg-red-50 dark:border-red-600 dark:text-red-200 dark:hover:bg-red-950/40",
            )}
            disabled={!canStop || !!controlBusy}
            onClick={() => void control("stop")}
          >
            {controlBusy === "stop" ? "Stopping…" : "Stop"}
          </Button>
          </LiveSessionActions>
        }
      />

      {runRow?.currentStep ? (
        <div className="rounded-xl border border-border/80 bg-card px-4 py-3 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-medium text-foreground">Current step</span>
            <span className="font-mono text-xs text-muted-foreground">{runRow.currentStep}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{
                width: runRow.status === "COMPLETED" ? "100%" : runRow.status === "RUNNING" ? "55%" : "25%",
              }}
            />
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3 lg:gap-8">
        <Card className="lg:col-span-2">
          <CardHeader className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle>noVNC workspace</CardTitle>
              </div>
              {vncWorkspaces.length > 0 ? (
                <div className="flex shrink-0 flex-col gap-1">
                  <label htmlFor="preview-workspace" className="text-xs font-medium text-muted-foreground">
                    noVNC workspace
                  </label>
                  <NativeSelect
                    id="preview-workspace"
                    value={previewWorkspace}
                    onChange={(e) => setPreviewWorkspace(Number(e.target.value) as 1 | 2)}
                  >
                    {vncWorkspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        Workspace {w.id} — {w.label}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {gdmsBrowserUrl && vncWorkspaces.length > 0 ? (
              <iframe
                title={`GDMS noVNC workspace ${previewWorkspace}`}
                src={gdmsBrowserUrl}
                className="h-[min(52vh,520px)] w-full rounded border border-border bg-black"
                allow="clipboard-read; clipboard-write"
              />
            ) : (
              <div className="flex h-64 flex-col items-center justify-center gap-2 rounded bg-muted px-4 text-center text-sm text-muted-foreground">
                <p>{previewHint}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <LiveSessionLogPanel
          logs={runId || endedRun ? logs : []}
          runStatus={runRow?.status}
          prominentError={
            runFailed || runPausedUser ? friendlyError ?? runRow?.errorMessage ?? null : null
          }
          onClearLogs={() => useLiveStore.getState().clearLogs()}
        />
      </div>
    </>
  );
}
