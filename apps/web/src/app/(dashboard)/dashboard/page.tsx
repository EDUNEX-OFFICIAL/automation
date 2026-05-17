"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ENABLED_AUTOMATION_OPERATIONS,
  AUTOMATION_SOURCES,
  OPERATION_LABELS,
  SUB_SOURCES_BY_PARENT,
  SUB_SOURCE_PARENTS,
  isAutomationFormValid,
  sourceNeedsSubSource,
  type AutomationOperation,
  type AutomationSource,
  type SubSourceParent,
  type SubSourcesSelection,
} from "@gdms/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiHttpError, apiFetch } from "@/lib/api";
import type { GdmsAccountSummary } from "@/lib/gdms-account";
import {
  loadSessionByRunId,
  persistAutomationRun,
  resumeSavedAutomationSession,
  startAutomationFromSessionId,
  type WorkflowRunDetail,
} from "@/lib/saved-automation-session";
import { toUserMessage } from "@/lib/user-messages";
import { useAuthStore } from "@/stores/auth-store";
import {
  useAutomationSessionStore,
  type SavedAutomationSession,
} from "@/stores/automation-session-store";
import { useLiveStore } from "@/stores/live-store";

export default function DashboardPage() {
  const router = useRouter();
  const token = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const resetLogs = useLiveStore((s) => s.resetLogs);
  const clearSavedSession = useAutomationSessionStore((s) => s.clear);
  const [dealers, setDealers] = useState<{ id: string; name: string }[]>([]);
  const [gdmsByDealer, setGdmsByDealer] = useState<Map<string, GdmsAccountSummary>>(new Map());
  const [dealerId, setDealerId] = useState<string>("");
  const savedSession = useAutomationSessionStore((s) =>
    dealerId ? s.byDealer[dealerId] : undefined,
  );
  const [msg, setMsg] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [sessionIdInput, setSessionIdInput] = useState("");
  const [sessionPreview, setSessionPreview] = useState<SavedAutomationSession | null>(null);
  const [sessionRunStatus, setSessionRunStatus] = useState<string | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [startingFromSession, setStartingFromSession] = useState(false);
  const [operation, setOperation] = useState<AutomationOperation | "">("enquiry_transfer");
  const [sources, setSources] = useState<AutomationSource[]>([]);
  const [subSources, setSubSources] = useState<SubSourcesSelection>({});

  useEffect(() => {
    if (!token) router.replace("/login");
  }, [token, router]);

  useEffect(() => {
    if (!token) return;
    void Promise.all([
      apiFetch<{ id: string; name: string }[]>("/v1/dealers", { token }),
      apiFetch<GdmsAccountSummary[]>("/v1/gdms-accounts", { token }),
    ]).then(([d, accounts]) => {
      setDealers(d);
      setGdmsByDealer(new Map(accounts.map((a) => [a.dealerId, a])));
      if (user?.dealerId) {
        setDealerId(user.dealerId);
      } else if (d[0]) {
        setDealerId((prev) => prev || d[0]!.id);
      }
    });
  }, [token, user?.dealerId]);

  useEffect(() => {
    const saved = dealerId ? useAutomationSessionStore.getState().get(dealerId) : undefined;
    if (saved?.runId && !sessionIdInput) {
      setSessionIdInput(saved.runId);
    }
  }, [dealerId, sessionIdInput]);

  useEffect(() => {
    if (!token || !dealerId) return;
    void apiFetch<{ clearedRunIds?: string[] }>("/v1/workflow-runs/reconcile-stale", {
      method: "POST",
      token,
      body: JSON.stringify({ dealerId }),
    }).catch(() => {});
  }, [token, dealerId]);

  const selectedGdms = gdmsByDealer.get(dealerId);

  const activeSubParents = useMemo(
    () => SUB_SOURCE_PARENTS.filter((p) => sources.includes(p)),
    [sources],
  );

  const formValid = isAutomationFormValid(operation, sources, subSources);
  const canStart = formValid && Boolean(selectedGdms?.configured);

  function onOperationChange(value: string): void {
    const op = value as AutomationOperation | "";
    setOperation(op);
    setSources([]);
    setSubSources({});
  }

  function toggleSource(source: AutomationSource): void {
    setSources((prev) => {
      const next = prev.includes(source)
        ? prev.filter((s) => s !== source)
        : [...prev, source];
      if (!next.includes(source) && sourceNeedsSubSource(source)) {
        setSubSources((sub) => {
          const copy = { ...sub };
          delete copy[source];
          return copy;
        });
      }
      return next;
    });
  }

  function toggleSubSource(parent: SubSourceParent, sub: string): void {
    setSubSources((prev) => {
      const current = prev[parent] ?? [];
      const next = current.includes(sub)
        ? current.filter((s) => s !== sub)
        : [...current, sub];
      if (next.length === 0) {
        const copy = { ...prev };
        delete copy[parent];
        return copy;
      }
      return { ...prev, [parent]: next };
    });
  }

  function canResumeSaved(saved: SavedAutomationSession | undefined): boolean {
    if (!saved) return false;
    return Boolean(saved.otpVerifiedAt || saved.gdmsReadyAt);
  }

  function applySessionToForm(saved: SavedAutomationSession): void {
    setDealerId(saved.dealerId);
    setOperation(saved.operation);
    setSources(saved.sources);
    setSubSources(saved.subSources ?? {});
    setSessionPreview(saved);
  }

  async function loadSessionPreview(): Promise<void> {
    if (!token || loadingSession) return;
    const id = sessionIdInput.trim();
    if (!id) {
      setMsg("Enter a session ID first (the Run ID from Live session).");
      setSessionPreview(null);
      setSessionRunStatus(null);
      return;
    }
    setMsg(null);
    setLoadingSession(true);
    try {
      const saved = await loadSessionByRunId(token, id);
      const run = await apiFetch<WorkflowRunDetail>(
        `/v1/workflow-runs/${encodeURIComponent(saved.runId)}`,
        { token },
      );
      applySessionToForm(saved);
      setSessionRunStatus(run.status);
    } catch (e) {
      setSessionPreview(null);
      setSessionRunStatus(null);
      setMsg(toUserMessage(e, "generic"));
    } finally {
      setLoadingSession(false);
    }
  }

  async function startFromSessionId(): Promise<void> {
    if (!token || startingFromSession) return;
    const id = sessionIdInput.trim();
    if (!id) {
      setMsg("Enter a session ID first (the Run ID from Live session).");
      return;
    }
    setMsg(null);
    resetLogs();
    setStartingFromSession(true);
    try {
      const saved = await startAutomationFromSessionId(token, id);
      applySessionToForm(saved);
      router.push("/live-session");
    } catch (e) {
      setMsg(toUserMessage(e, "generic"));
    } finally {
      setStartingFromSession(false);
    }
  }

  async function resumeSession(): Promise<void> {
    if (!token || !dealerId || !savedSession || resuming) return;
    setMsg(null);
    setResuming(true);
    try {
      await resumeSavedAutomationSession(token, savedSession);
      router.push("/live-session");
    } catch (e) {
      setMsg(toUserMessage(e, "generic"));
    } finally {
      setResuming(false);
    }
  }

  async function start(fresh = false): Promise<void> {
    if (starting) return;
    if (!token || !dealerId) {
      setMsg("Select a dealer and configure GDMS in Settings first.");
      return;
    }
    if (!operation || !formValid) return;
    setMsg(null);
    resetLogs();
    if (fresh) clearSavedSession(dealerId);
    setStarting(true);
    try {
      const body: {
        dealerId: string;
        operation: AutomationOperation;
        sources: AutomationSource[];
        subSources?: SubSourcesSelection;
      } = {
        dealerId,
        operation,
        sources,
      };
      if (Object.keys(subSources).length > 0) {
        body.subSources = subSources;
      }
      const run = await apiFetch<{ id: string }>("/v1/workflow-runs", {
        method: "POST",
        token,
        body: JSON.stringify(body),
      });
      persistAutomationRun({
        runId: run.id,
        dealerId,
        operation,
        sources,
        subSources: Object.keys(subSources).length > 0 ? subSources : undefined,
      });
      router.push("/live-session");
    } catch (e) {
      if (e instanceof ApiHttpError && e.status === 409) {
        const body = e.body as { runId?: string; error?: string } | null;
        if (body?.runId && operation) {
          persistAutomationRun({
            runId: body.runId,
            dealerId,
            operation,
            sources,
            subSources: Object.keys(subSources).length > 0 ? subSources : undefined,
          });
          setMsg("Using your existing open automation — opening Live session.");
          router.push("/live-session");
          return;
        }
      }
      setMsg(toUserMessage(e, "generic"));
    } finally {
      setStarting(false);
    }
  }

  if (!token) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">Dashboard</h1>
        <p className="text-sm text-zinc-600">
          Choose an operation and sources, then press START — or enter a saved session ID to resume
          an existing browser profile without OTP.
        </p>
      </div>

      {savedSession && canResumeSaved(savedSession) ? (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-blue-950">
          <p className="font-medium">Saved automation session</p>
          <p className="mt-1 text-sm text-blue-900">
            Run <span className="font-mono text-xs">{savedSession.runId}</span>
            {savedSession.gdmsReadyAt ? " · GDMS home was reached" : null}
            {savedSession.otpVerifiedAt && !savedSession.gdmsReadyAt ? " · OTP already entered" : null}
            . Resume to avoid entering OTP again when the browser is still open.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" disabled={resuming} onClick={() => void resumeSession()}>
              {resuming ? "Resuming…" : "Resume saved session"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="border-blue-300 bg-white"
              disabled={starting}
              onClick={() => void start(true)}
            >
              Start fresh (new run)
            </Button>
            <Link
              href="/live-session"
              className="inline-flex items-center text-sm text-blue-800 underline"
            >
              Live session
            </Link>
          </div>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Dealer</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <select
            className="rounded border border-zinc-200 px-2 py-2 text-sm"
            value={dealerId}
            onChange={(e) => setDealerId(e.target.value)}
          >
            {dealers.map((d) => {
              const configured = gdmsByDealer.get(d.id)?.configured;
              return (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {configured ? " · GDMS ready" : ""}
                </option>
              );
            })}
          </select>
          {selectedGdms?.configured ? (
            <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800">
              GDMS: {selectedGdms.usernameMasked}
            </span>
          ) : (
            <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">
              GDMS not configured
            </span>
          )}
          <Link href="/settings" className="text-sm text-blue-600 underline">
            Settings
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Start from saved session</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-zinc-600">
            Paste the <strong>Session ID</strong> (workflow run ID from Live session, e.g.{" "}
            <span className="font-mono text-xs">cmp9xc2gx0001vxqo9811deen</span>). Automation uses
            that run&apos;s saved sources and sub-sources, then opens the browser profile without a
            new OTP when possible.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="session-id">Session ID</Label>
            <Input
              id="session-id"
              placeholder="cmp9xc2gx0001vxqo9811deen"
              value={sessionIdInput}
              onChange={(e) => {
                setSessionIdInput(e.target.value);
                setSessionPreview(null);
                setSessionRunStatus(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void loadSessionPreview();
              }}
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loadingSession || !sessionIdInput.trim()}
              onClick={() => void loadSessionPreview()}
            >
              {loadingSession ? "Loading…" : "Verify session"}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={startingFromSession || !sessionIdInput.trim()}
              onClick={() => void startFromSessionId()}
            >
              {startingFromSession ? "Starting…" : "Start from session ID"}
            </Button>
          </div>
          {sessionPreview ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-950">
              <p className="font-medium">Session loaded</p>
              <p className="mt-1 font-mono text-xs">{sessionPreview.runId}</p>
              {sessionRunStatus ? (
                <p className="mt-1 text-xs">Status: {sessionRunStatus}</p>
              ) : null}
              <p className="mt-1 text-xs">
                {OPERATION_LABELS[sessionPreview.operation]} ·{" "}
                {sessionPreview.sources.join(", ")}
              </p>
              {SUB_SOURCE_PARENTS.filter((p) => sessionPreview.subSources?.[p]?.length).map(
                (parent) => (
                  <p key={parent} className="text-xs">
                    {parent}: {(sessionPreview.subSources?.[parent] ?? []).join(", ")}
                  </p>
                ),
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Automation</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="operation">Operation</Label>
              <select
                id="operation"
                className="w-full rounded border border-zinc-200 px-2 py-2 text-sm"
                value={operation}
                onChange={(e) => onOperationChange(e.target.value)}
              >
                <option value="">Select operation…</option>
                {ENABLED_AUTOMATION_OPERATIONS.map((op) => (
                  <option key={op} value={op}>
                    {OPERATION_LABELS[op]}
                  </option>
                ))}
              </select>
            </div>

            {operation ? (
              <div className="space-y-1.5">
                <Label>Sources</Label>
                <div className="rounded border border-zinc-200 p-2">
                  <ul className="flex flex-col gap-1.5">
                    {AUTOMATION_SOURCES.map((source) => (
                      <li key={source}>
                        <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-800">
                          <input
                            type="checkbox"
                            className="rounded border-zinc-300"
                            checked={sources.includes(source)}
                            onChange={() => toggleSource(source)}
                          />
                          {source}
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}

            {activeSubParents.map((parent) => (
              <div key={parent} className="space-y-1.5">
                <Label>Sub sources ({parent})</Label>
                <div className="rounded border border-zinc-200 p-2">
                  <ul className="flex flex-col gap-1.5">
                    {SUB_SOURCES_BY_PARENT[parent].map((sub) => (
                      <li key={sub}>
                        <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-800">
                          <input
                            type="checkbox"
                            className="rounded border-zinc-300"
                            checked={(subSources[parent] ?? []).includes(sub)}
                            onChange={() => toggleSubSource(parent, sub)}
                          />
                          {sub}
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}

            <Button disabled={!canStart || starting} onClick={() => void start()}>
              {starting ? "Starting…" : "START"}
            </Button>
            {!selectedGdms?.configured && operation ? (
              <p className="text-sm text-amber-800">Configure GDMS credentials in Settings to enable START.</p>
            ) : null}
            {msg ? (
              <p className="text-sm text-amber-800">
                {msg}
                {msg.toLowerCase().includes("already running") ? (
                  <>
                    {" "}
                    <Link className="font-medium underline" href="/live-session">
                      Open Live session
                    </Link>{" "}
                    and press Stop if a browser session is still open.
                  </>
                ) : null}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick links</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <Link className="text-blue-600 underline" href="/live-session">
              Live automation viewer
            </Link>
            <Link className="text-blue-600 underline" href="/leads">
              Leads panel
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
