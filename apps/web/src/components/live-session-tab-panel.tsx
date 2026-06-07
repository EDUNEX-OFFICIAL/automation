"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LiveSessionLogPanel } from "@/components/live-session-log-panel";
import { LiveSessionActions } from "@/components/live-session-actions";
import { RunStatusBadge } from "@/components/run-status-badge";
import { StatusBanner } from "@/components/ui/status-banner";
import { OtpEntryPanel } from "@/components/otp-entry-panel";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { toUserMessage } from "@/lib/user-messages";
import {
  terminateLiveSessionLocally,
} from "@/lib/terminate-live-session";
import { useLiveStore } from "@/stores/live-store";

const EMPTY_LOGS: { level: string; message: string; ts: string }[] = [];

export type WorkflowRunRow = {
  id: string;
  status: string;
  currentStep: string | null;
  errorMessage: string | null;
  startedAt: string;
  endedAt: string | null;
  runParams?: { operation?: string } | null;
  liveLogs?: { level: string; message: string; ts: string }[];
};

type LiveSessionTabPanelProps = {
  tabLabel: string;
  workspace: 1 | 2 | 3;
  operation: "enquiry_transfer" | "follow_up_skip" | "lost_inquiry";
  runRow: WorkflowRunRow | null;
  sessionActive: boolean;
  vncUrl: string | null;
  token: string;
  userId: string | undefined;
  realtimeConnected: boolean;
  onRunEnded: () => void;
};

function friendlyRunError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return toUserMessage(raw, "generic");
}

export function LiveSessionTabPanel({
  tabLabel,
  workspace,
  operation,
  runRow,
  sessionActive,
  vncUrl,
  token,
  userId,
  realtimeConnected,
  onRunEnded,
}: LiveSessionTabPanelProps) {
  const runId = runRow?.id ?? null;
  const logs = useLiveStore((s) =>
    runId ? (s.logsByRunId[runId] ?? EMPTY_LOGS) : EMPTY_LOGS,
  );
  const otpPending = useLiveStore((s) => s.otpPending && s.otpRunId === runId);
  const lastStep = useLiveStore((s) => (s.runId === runId ? s.lastStep : null));

  const [controlBusy, setControlBusy] = useState<"pause" | "resume" | "stop" | null>(null);
  const [controlNotice, setControlNotice] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [requeuing, setRequeuing] = useState(false);
  const [logoutMessage, setLogoutMessage] = useState<string | null>(null);
  const [vncFrameKey, setVncFrameKey] = useState(0);

  const runFailed = runRow?.status === "FAILED";
  const runPausedUser = runRow?.status === "PAUSED_USER";
  const runIsActive = runRow?.status === "RUNNING" || runRow?.status === "PAUSED_OTP";
  const runStopped = runRow?.status === "STOPPED";
  const friendlyError = friendlyRunError(runRow?.errorMessage);

  const pendingAgeMs =
    runRow?.status === "PENDING" && runRow.startedAt
      ? Date.now() - Date.parse(runRow.startedAt)
      : 0;
  const runAgeMs = runRow?.startedAt ? Date.now() - Date.parse(runRow.startedAt) : 0;
  const showRequeue = !!runId && runRow?.status === "PENDING" && pendingAgeMs > 20_000 && !requeuing;
  const recentLogActivity =
    logs.length > 0 && Date.now() - Date.parse(logs[logs.length - 1]!.ts) < 45_000;
  const runLostBrowser =
    !!runId &&
    runRow?.status === "RUNNING" &&
    !sessionActive &&
    !recentLogActivity &&
    !realtimeConnected &&
    runAgeMs > 15_000;

  const isFollowUpSkip = operation === "follow_up_skip";
  const isLostInquiry = operation === "lost_inquiry";

  const canContinueWhileRunning =
    runRow?.status === "RUNNING" &&
    (lastStep?.includes("Wait for GDMS dashboard") ||
      logs.some((l) => /still waiting for dashboard/i.test(l.message)));

  const canRetryTransfer =
    !!runId &&
    !retrying &&
    (runFailed ||
      runPausedUser ||
      canContinueWhileRunning ||
      runLostBrowser ||
      (sessionActive && runRow?.status === "RUNNING"));

  const retryButtonLabel = !sessionActive
    ? "Resume saved session"
    : runRow?.status === "RUNNING"
      ? isLostInquiry
        ? "Continue lost inquiry"
        : isFollowUpSkip
          ? "Continue follow up skip"
          : "Continue transfer"
      : isLostInquiry
        ? "Retry lost inquiry"
        : isFollowUpSkip
          ? "Retry follow up skip"
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
  const canGdmsLogout = !!runId && sessionActive;

  const controlBtnDisabledClass =
    "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-35 disabled:grayscale disabled:hover:bg-inherit disabled:hover:text-inherit";

  const showVnc =
    Boolean(vncUrl) &&
    Boolean(runId) &&
    (sessionActive || runStatus === "RUNNING" || runStatus === "PAUSED_OTP" || runStatus === "PAUSED_USER");

  const previewHint = !runId
    ? "No active run — start from Dashboard or Settings."
    : !showVnc
      ? runStopped
        ? "Remote view ended."
        : runFailed || runPausedUser
          ? friendlyError ?? "Needs attention — use controls below."
          : runRow?.status === "PENDING"
            ? "Queued… browser will appear when the run starts."
            : "Waiting for GDMS browser session…"
      : !realtimeConnected
        ? "Connecting…"
        : "Live noVNC view.";

  function pushTabLog(l: { level: string; message: string; ts: string }): void {
    if (!runId) return;
    useLiveStore.getState().pushLogForRun(runId, l);
  }

  async function control(action: "pause" | "resume" | "stop"): Promise<void> {
    if (!token || !runId || controlBusy) return;
    if (action === "stop" && !window.confirm(`Stop ${tabLabel}? The browser session will end.`)) {
      return;
    }
    setControlBusy(action);
    setControlNotice(null);
    try {
      const res = await apiFetch<{ ok: boolean; status?: string }>(
        `/v1/workflow-runs/${runId}/control`,
        { method: "POST", token, body: JSON.stringify({ action }) },
      );
      const label =
        action === "pause" ? "Paused." : action === "resume" ? "Resumed." : "Stopped.";
      setControlNotice(label);
      pushTabLog({ level: "info", message: label, ts: new Date().toISOString() });
      if (action === "stop") {
        terminateLiveSessionLocally(userId);
        onRunEnded();
      } else if (res.status && runRow && res.status !== runRow.status) {
        /* parent poll will refresh */
      }
    } catch (e) {
      const msg = toUserMessage(e, "generic");
      setControlNotice(`Could not ${action}: ${msg}`);
      pushTabLog({ level: "warn", message: `Could not ${action}: ${msg}`, ts: new Date().toISOString() });
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
      pushTabLog({ level: "info", message: "Run queued again.", ts: new Date().toISOString() });
    } catch (e) {
      pushTabLog({
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
      await apiFetch(endpoint, { method: "POST", token, body: JSON.stringify({}) });
      pushTabLog({
        level: "info",
        message: sessionActive ? `Continuing ${tabLabel.toLowerCase()}.` : "Resuming saved session.",
        ts: new Date().toISOString(),
      });
    } catch (e) {
      pushTabLog({
        level: "warn",
        message: toUserMessage(e, "generic"),
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
      pushTabLog({ level: "info", message: "GDMS sign-out requested.", ts: new Date().toISOString() });
    } catch (e) {
      const msg = toUserMessage(e, "generic");
      setLogoutMessage(msg);
      pushTabLog({ level: "warn", message: msg, ts: new Date().toISOString() });
    }
  }

  return (
    <div className="space-y-4">
      {(runRow?.status === "PAUSED_OTP" || otpPending) && runId ? (
        <OtpEntryPanel variant="card" className="mb-2" />
      ) : null}

      {logoutMessage ? (
        <StatusBanner variant="error" title="Could not sign out of GDMS">
          {logoutMessage}
        </StatusBanner>
      ) : null}

      {runRow?.status === "PENDING" && pendingAgeMs > 20_000 ? (
        <StatusBanner variant="warning" title="Still queued" />
      ) : null}

      {runLostBrowser ? (
        <StatusBanner variant="warning" title="Browser session lost">
          The remote GDMS browser is not connected. Press <strong>{retryButtonLabel}</strong> below,
          or Stop and start again from Dashboard.
        </StatusBanner>
      ) : null}

      {controlNotice ? (
        <div className="rounded-lg border border-info/25 bg-info/10 px-4 py-2.5 text-sm text-foreground">
          {controlNotice}
        </div>
      ) : null}

      {(runFailed || runPausedUser) && friendlyError && !runIsActive ? (
        <StatusBanner variant="error" title={runPausedUser ? "Paused" : "Failed"}>
          {friendlyError}
        </StatusBanner>
      ) : null}

      <LiveSessionActions className="flex-wrap">
        <RunStatusBadge status={runRow?.status} />
        {showVnc ? (
          <Button
            size="sm"
            variant="default"
            className="hidden bg-primary hover:bg-primary/90 md:inline-flex"
            onClick={() => {
              window.open(
                vncUrl!,
                `gdms-browser-ws${workspace}`,
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

      {runRow?.currentStep ? (
        <div className="rounded-xl border border-border/80 bg-card px-4 py-3 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-medium text-foreground">Current step</span>
            <span className="font-mono text-xs text-muted-foreground">{runRow.currentStep}</span>
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3 lg:gap-8">
        <Card className="lg:col-span-2">
          <CardHeader className="space-y-1">
            <CardTitle>{tabLabel}</CardTitle>
            <p className="text-sm text-muted-foreground">{previewHint}</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {showVnc ? (
              <>
                <iframe
                  key={`${vncFrameKey}-${workspace}`}
                  title={`GDMS noVNC — ${tabLabel}`}
                  src={vncUrl!}
                  className="aspect-video w-full max-h-[80vh] rounded border border-border bg-black"
                  allow="clipboard-read; clipboard-write"
                />
                <div className="flex justify-end">
                  <Button size="sm" variant="outline" onClick={() => setVncFrameKey((k) => k + 1)}>
                    Reconnect noVNC
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex h-64 flex-col items-center justify-center gap-2 rounded bg-muted px-4 text-center text-sm text-muted-foreground">
                <p>{previewHint}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <LiveSessionLogPanel
          logs={logs}
          runStatus={runRow?.status}
          prominentError={
            runFailed || runPausedUser ? friendlyError ?? runRow?.errorMessage ?? null : null
          }
          onClearLogs={() => {
            if (runId) useLiveStore.getState().clearLogsForRun(runId);
          }}
        />
      </div>
    </div>
  );
}
