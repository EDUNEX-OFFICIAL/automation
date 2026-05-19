"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBanner } from "@/components/ui/status-banner";
import { LiveSessionLogPanel } from "@/components/live-session-log-panel";
import { RunStatusBadge } from "@/components/run-status-badge";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { toUserMessage } from "@/lib/user-messages";
import { useAuthStore } from "@/stores/auth-store";
import { linkLiveSessionToInFlightRun } from "@/lib/saved-automation-session";
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
  const runId = useLiveStore((s) => s.runId);
  const frame = useLiveStore((s) => s.frameBase64);
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

  useEffect(() => {
    if (!token) router.replace("/login");
  }, [token, router]);

  useEffect(() => {
    if (!token) return;
    void apiFetch<{ enabled: boolean; workspaces?: GdmsVncWorkspaceView[] }>("/v1/gdms-browser-view", {
      token,
    })
      .then((r) => setVncWorkspaces(r.enabled && r.workspaces?.length ? r.workspaces : []))
      .catch(() => setVncWorkspaces([]));
  }, [token]);

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

  const dealerId = useAuthStore((s) => s.user?.dealerId);
  const sessionHydrated = useAutomationSessionStore.persist?.hasHydrated?.() ?? true;

  useEffect(() => {
    if (!sessionHydrated || !token) return;

    const linkRun = (): void => {
      if (useLiveStore.getState().runId) return;
      if (dealerId) {
        void apiFetch<WorkflowRunRow[]>(`/v1/workflow-runs?dealerId=${dealerId}`, { token })
          .then((runs) => {
            if (useLiveStore.getState().runId) return;
            const pick =
              runs.find((r) => r.status === "RUNNING") ??
              runs.find((r) => r.status === "PAUSED_OTP") ??
              runs.find((r) => r.status === "PENDING");
            if (pick?.id) useLiveStore.getState().setRun(pick.id);
          })
          .catch(() => {});
        return;
      }
      void linkLiveSessionToInFlightRun(token).catch(() => {});
    };

    linkRun();
    const t = window.setInterval(linkRun, 4000);
    return () => window.clearInterval(t);
  }, [sessionHydrated, dealerId, token]);

  useEffect(() => {
    if (runRow?.status === "PAUSED_OTP" && runId) {
      useLiveStore.getState().openOtp(runId);
    }
  }, [runRow?.status, runId]);

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
              terminateLiveSessionLocally(dealerId);
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
  }, [token, runId]);

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
        action === "pause"
          ? "Paused — fix anything in GDMS if needed, then press Resume."
          : action === "resume"
            ? "Resumed — automation continues on the server."
            : "Stopped — you can start a new run from the Dashboard.";
      setControlNotice(label);
      useLiveStore.getState().pushLog({
        level: "info",
        message: label,
        ts: new Date().toISOString(),
      });
      if (action === "stop") {
        terminateLiveSessionLocally(dealerId);
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
        message: sessionActive
          ? runRow?.status === "RUNNING"
            ? "Continue transfer signalled — finish login on the home screen if needed."
            : "Retry transfer started on the open browser session."
          : "Resuming from saved browser profile (same run, no new OTP).",
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

  async function gdmsLogout(): Promise<void> {
    if (!token || !runId) return;
    setLogoutMessage(null);
    try {
      await apiFetch(`/v1/workflow-runs/${runId}/gdms-logout`, {
        method: "POST",
        token,
        body: JSON.stringify({}),
      });
      const okMsg =
        "GDMS logout requested — login page should appear in the preview shortly.";
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
  const needsBrowserSetup =
    !!runRow?.errorMessage &&
    /executable doesn't exist|playwright install/i.test(runRow.errorMessage);

  const previewHint = !runId
    ? "No active run — start enquiry transfer from the Dashboard; Follow Up Skip runs on the schedule in Settings."
    : !realtimeConnected
      ? "Connecting to live updates…"
      : runStopped
        ? "Live preview ended."
        : runFailed || runPausedUser
          ? friendlyError ?? "This run needs attention."
          : runRow?.status === "RUNNING"
            ? frame
              ? "Live GDMS preview from the automation server."
              : "Automation is running — preview frames will appear shortly."
            : runRow?.status === "PENDING"
              ? "Your run is queued. This usually takes a few seconds."
              : "Waiting for the browser preview…";

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
  const automationRunning = runRow?.status === "RUNNING" || runRow?.status === "PAUSED_OTP";
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
    <div className="space-y-4">
      {showPostLogin && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-green-900">
          <p className="font-medium">GDMS login / workflow complete</p>
          <p className="mt-1 text-sm text-green-800">
            The browser preview below should show Hyundai DMS <strong>logged-in (home / dashboard)</strong>.
            Preview stays live until you press Stop. If GDMS session times out, the login page opens automatically.
            Use <strong>Logout GDMS</strong> to sign out of the previewed site.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm" className="border-green-300 bg-white">
              <Link href="/leads">SaaS → Leads</Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="border-green-300 bg-white">
              <Link href="/dashboard">SaaS → Dashboard</Link>
            </Button>
          </div>
        </div>
      )}

      {automationRunning && (
        <StatusBanner variant="warning" title="Do not interrupt automation">
          GDMS runs in a browser on the automation server. Use <strong>Pause</strong> or{" "}
          <strong>Stop</strong> on this page only.
        </StatusBanner>
      )}

      {runRow?.status === "PAUSED_OTP" && (
        <StatusBanner variant="warning" title="OTP required">
          Submit the OTP from the popup on this page. The preview is read-only for login — typing OTP there does not continue automation.
        </StatusBanner>
      )}

      {runRow?.status === "RUNNING" && lastStep === "Enter OTP into GDMS" && (
        <p className="text-sm text-amber-800">
          OTP has been filled. Automation will click the blue <strong>Login</strong> button next. Wait for the preview to update.
        </p>
      )}

      {logoutMessage && (
        <StatusBanner variant="error" title="Could not sign out of GDMS">
          {logoutMessage}
        </StatusBanner>
      )}

      {runRow?.status === "PENDING" && pendingAgeMs > 20_000 ? (
        <StatusBanner variant="warning" title="Run is stuck in queue">
          The worker did not start this run yet. Press <strong>Retry queue</strong> or wait — we
          re-queue automatically. A black noVNC window is normal until Chrome starts on the server.
        </StatusBanner>
      ) : null}

      {controlNotice ? (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-950">
          {controlNotice}
        </div>
      ) : null}

      {friendlyError && runIsActive && sessionActive ? (
        <StatusBanner variant="warning" title="Earlier message (run still active)">
          {friendlyError} Use <strong>Stop</strong> to end the run, or let automation continue.
        </StatusBanner>
      ) : null}

      {(runFailed || runPausedUser) && friendlyError && !runIsActive && (
        <StatusBanner
          variant="error"
          title={runPausedUser ? "Manual intervention required" : "Automation could not run"}
        >
          {friendlyError}
          {sessionActive ? (
            <p className="mt-2 text-sm">
              The visible browser session may still be open. Fix the issue in GDMS, then press{" "}
              <strong>{isFollowUpSkipRun ? "Retry follow-up skip" : "Retry transfer"}</strong>.
            </p>
          ) : null}
          {runFailed && needsBrowserSetup ? (
            <p className="mt-2 font-mono text-xs opacity-80">
              Dev fix: run{" "}
              <code className="rounded bg-red-100 px-1">
                pnpm --filter @gdms/automation-service run pw:install
              </code>{" "}
              in the project folder, then restart{" "}
              <code className="rounded bg-red-100 px-1">pnpm dev</code>.
            </p>
          ) : null}
        </StatusBanner>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">Live session</h1>
            <RunStatusBadge status={runRow?.status} />
          </div>
          <p className="mt-1 font-mono text-xs text-zinc-600">{runId ?? "—"}</p>
          <p className="text-xs text-zinc-500">
            Live updates:{" "}
            <span className={realtimeConnected ? "font-medium text-emerald-700" : "text-amber-700"}>
              {realtimeConnected ? "connected" : "connecting…"}
            </span>
            {sessionActive ? " · Browser active on server" : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {gdmsBrowserUrl &&
          (sessionActive ||
            runRow?.status === "RUNNING" ||
            runRow?.status === "PAUSED_OTP") ? (
            <Button
              size="sm"
              variant="default"
              className="bg-blue-700 hover:bg-blue-800"
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
              canResume && !controlBusy && "border-emerald-300 hover:bg-emerald-50",
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
              canStop && !controlBusy && "border-red-300 text-red-900 hover:bg-red-50",
            )}
            disabled={!canStop || !!controlBusy}
            onClick={() => void control("stop")}
          >
            {controlBusy === "stop" ? "Stopping…" : "Stop"}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle>Browser preview</CardTitle>
                <p className="mt-1 text-xs font-normal text-zinc-500">
                  <strong>Workspace 1</strong> = Enquiry transfer · <strong>Workspace 2</strong> = Follow
                  Up Skip. Use the dropdown to switch noVNC; the JPEG below is the current Live run stream.
                </p>
              </div>
              {vncWorkspaces.length > 0 ? (
                <div className="flex shrink-0 flex-col gap-1">
                  <label htmlFor="preview-workspace" className="text-xs font-medium text-zinc-600">
                    noVNC workspace
                  </label>
                  <select
                    id="preview-workspace"
                    className="rounded border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                    value={previewWorkspace}
                    onChange={(e) => setPreviewWorkspace(Number(e.target.value) as 1 | 2)}
                  >
                    {vncWorkspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        Workspace {w.id} — {w.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {gdmsBrowserUrl && vncWorkspaces.length > 0 ? (
              <iframe
                title={`GDMS noVNC workspace ${previewWorkspace}`}
                src={gdmsBrowserUrl}
                className="h-[min(52vh,520px)] w-full rounded border border-zinc-200 bg-black"
                allow="clipboard-read; clipboard-write"
              />
            ) : null}
            {frame ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                alt="live"
                className="w-full rounded border border-zinc-200"
                src={`data:image/jpeg;base64,${frame}`}
              />
            ) : (
              <div className="flex h-64 flex-col items-center justify-center gap-2 rounded bg-zinc-100 px-4 text-center text-sm text-zinc-500">
                <p>{previewHint}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <LiveSessionLogPanel
          logs={logs}
          lastStepLabel={lastStep}
          apiCurrentStep={runRow?.currentStep ?? null}
          runStatus={runRow?.status}
          prominentError={
            runFailed || runPausedUser ? friendlyError ?? runRow?.errorMessage ?? null : null
          }
          onClearLogs={() => useLiveStore.getState().resetLogs()}
        />
      </div>
    </div>
  );
}
