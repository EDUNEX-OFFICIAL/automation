"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBanner } from "@/components/ui/status-banner";
import { LiveSessionLogPanel } from "@/components/live-session-log-panel";
import { apiFetch } from "@/lib/api";
import { toUserMessage } from "@/lib/user-messages";
import { useAuthStore } from "@/stores/auth-store";
import { linkLiveSessionToInFlightRun } from "@/lib/saved-automation-session";
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

  useEffect(() => {
    if (!token) router.replace("/login");
  }, [token, router]);

  const dealerId = useAuthStore((s) => s.user?.dealerId);
  const sessionHydrated = useAutomationSessionStore.persist?.hasHydrated?.() ?? true;

  useEffect(() => {
    if (!sessionHydrated || !token) return;

    const linkRun = (): void => {
      if (useLiveStore.getState().runId) return;
      if (dealerId) {
        const saved = useAutomationSessionStore.getState().get(dealerId);
        if (saved?.runId) {
          useLiveStore.getState().setRun(saved.runId);
          return;
        }
        void apiFetch<WorkflowRunRow[]>(`/v1/workflow-runs?dealerId=${dealerId}`, { token })
          .then((runs) => {
            if (useLiveStore.getState().runId) return;
            const pick =
              runs.find((r) => r.status === "RUNNING" || r.status === "PAUSED_USER") ??
              runs.find((r) => r.status === "PAUSED_OTP" || r.status === "PENDING") ??
              runs[0];
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
    if (!token || !runId) {
      setRunRow(null);
      return;
    }
    let stop = false;
    const poll = (): void => {
      void apiFetch<WorkflowRunRow>(`/v1/workflow-runs/${runId}`, { token })
        .then((r) => {
          if (!stop) setRunRow(r);
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
    if (!token || !runId) return;
    await apiFetch(`/v1/workflow-runs/${runId}/control`, {
      method: "POST",
      token,
      body: JSON.stringify({ action }),
    });
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
  const runStopped = runRow?.status === "STOPPED";
  const friendlyError = friendlyRunError(runRow?.errorMessage);
  const needsBrowserSetup =
    !!runRow?.errorMessage &&
    /executable doesn't exist|playwright install/i.test(runRow.errorMessage);

  const statusHint = runRow
    ? runRow.status
    : runId
      ? "Loading status…"
      : "—";

  const previewHint = !runId
    ? "No run linked — open Dashboard and use Resume saved session, or start a new run."
    : !realtimeConnected
      ? "Connecting to live updates…"
      : runStopped
        ? "Live preview ended."
        : runFailed || runPausedUser
          ? friendlyError ?? "This run needs attention."
          : runRow?.status === "RUNNING"
            ? "Visible GDMS browser mode — watch the automation window on this machine (live stream off)."
            : runRow?.status === "PENDING"
              ? "Your run is queued. This usually takes a few seconds."
              : "Waiting for the browser preview…";

  const showPostLogin = workflowDone || runRow?.status === "COMPLETED";
  const canContinueWhileRunning =
    runRow?.status === "RUNNING" &&
    (lastStep?.includes("Wait for GDMS dashboard") ||
      logs.some((l) => /still waiting for dashboard/i.test(l.message)));
  const canRequeue = !!runId && runRow?.status === "PENDING" && !requeuing;
  const canRetryTransfer =
    !!runId &&
    !retrying &&
    (runFailed || runPausedUser || canContinueWhileRunning || (sessionActive && runRow?.status === "RUNNING"));
  const retryButtonLabel = !sessionActive
    ? "Resume saved session"
    : runRow?.status === "RUNNING"
      ? "Continue transfer"
      : "Retry transfer";
  const automationRunning = runRow?.status === "RUNNING" || runRow?.status === "PAUSED_OTP";
  const runStatus = runRow?.status;
  const isAutomationRunning =
    runStatus === "RUNNING" || runStatus === "PAUSED_OTP" || runStatus === "PENDING";
  const isAutomationPaused = runStatus === "PAUSED_USER" || runStatus === "FAILED";
  const canPause = !!runId && isAutomationRunning;
  const canResume = !!runId && isAutomationPaused;
  const canStop = !!runId && (isAutomationRunning || isAutomationPaused);
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
        <StatusBanner variant="warning" title="Do not touch the GDMS browser window">
          Automation controls the visible Chromium window on this PC. Mouse and keyboard input there are
          blocked. Use <strong>Pause</strong> or <strong>Stop</strong> on this page only.
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

      {(runFailed || runPausedUser) && friendlyError && (
        <StatusBanner
          variant="error"
          title={runPausedUser ? "Manual intervention required" : "Automation could not run"}
        >
          {friendlyError}
          {sessionActive ? (
            <p className="mt-2 text-sm">
              The visible browser session may still be open. Fix the issue in GDMS, then press{" "}
              <strong>Retry transfer</strong>.
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
          <h1 className="text-2xl font-semibold">Live session</h1>
          <p className="text-sm text-zinc-600">Run: {runId ?? "—"}</p>
          <p className="text-xs text-zinc-500">
            Live updates: {realtimeConnected ? "connected" : "connecting…"} · Status: {statusHint}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canRequeue ? (
            <Button size="sm" onClick={() => void requeueRun()}>
              {requeuing ? "Queuing…" : "Retry queue"}
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
            className={controlBtnDisabledClass}
            disabled={!canPause}
            onClick={() => void control("pause")}
          >
            Pause
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={controlBtnDisabledClass}
            disabled={!canResume}
            onClick={() => void control("resume")}
          >
            Resume
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
            className={controlBtnDisabledClass}
            disabled={!canStop}
            onClick={() => void control("stop")}
          >
            Stop
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Browser preview</CardTitle>
            <p className="text-xs font-normal text-zinc-500">
              Enquiry transfer uses a visible Chromium window on this machine — JPEG stream is usually off; placeholder
              text below explains connection status.
            </p>
          </CardHeader>
          <CardContent>
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
        />
      </div>
    </div>
  );
}
