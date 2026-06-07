"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  DASHBOARD_MANUAL_OPERATIONS,
  AUTOMATION_SOURCES,
  OPERATION_LABELS,
  SUB_SOURCES_BY_PARENT,
  SUB_SOURCE_PARENTS,
  isAutomationFormValid,
  operationNeedsSources,
  isWorkflowRunId,
  looksLikeGdmsCookieToken,
  sourceNeedsSubSource,
  type AutomationOperation,
  type AutomationSource,
  type SubSourceParent,
  type SubSourcesSelection,
} from "@gdms/shared";
import { ShieldCheck, CalendarClock, Zap, History, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/layout/stat-card";
import { SectionBlock } from "@/components/layout/section-block";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiHttpError, apiFetch } from "@/lib/api";
import type { GdmsAccountSummary } from "@/lib/gdms-account";
import { persistAutomationRun, resumeSavedAutomationSession } from "@/lib/saved-automation-session";
import { toUserMessage } from "@/lib/user-messages";
import { NativeSelect } from "@/components/ui/native-select";
import { TEAM_TYPE_LABELS, canEditScheduleSettings, type TeamType } from "@/lib/roles";
import { useAuthStore } from "@/stores/auth-store";
import {
  useAutomationSessionStore,
  type SavedAutomationSession,
} from "@/stores/automation-session-store";
import { useLiveStore } from "@/stores/live-store";

export function OperationsWorkspace() {
  const router = useRouter();
  const token = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const syncUserFromApi = useAuthStore((s) => s.syncUserFromApi);
  const resetLogs = useLiveStore((s) => s.resetLogs);
  const clearSavedSession = useAutomationSessionStore((s) => s.clear);
  const [dealers, setDealers] = useState<{ id: string; name: string }[]>([]);
  const [myGdms, setMyGdms] = useState<GdmsAccountSummary | null>(null);
  const [dealerId, setDealerId] = useState<string>("");
  const userId = user?.id;
  const savedSession = useAutomationSessionStore((s) =>
    userId ? s.byUser[userId] : undefined,
  );
  const [msg, setMsg] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [gdmsTokenInput, setGdmsTokenInput] = useState("");
  const [savingToken, setSavingToken] = useState(false);
  const [operation, setOperation] = useState<AutomationOperation | "">("enquiry_transfer");
  const [sources, setSources] = useState<AutomationSource[]>([]);
  const [subSources, setSubSources] = useState<SubSourcesSelection>({});
  const [followUpSkipEnabled, setFollowUpSkipEnabled] = useState(false);
  const [followUpSkipStartTime, setFollowUpSkipStartTime] = useState<string | null>(null);
  const [followUpSkipInFlight, setFollowUpSkipInFlight] = useState(false);
  const [followUpSkipStarting, setFollowUpSkipStarting] = useState(false);
  const [lostInquiryEnabled, setLostInquiryEnabled] = useState(false);
  const [lostInquiryStartTime, setLostInquiryStartTime] = useState<string | null>(null);
  const [lostInquiryInFlight, setLostInquiryInFlight] = useState(false);
  const [lostInquiryStarting, setLostInquiryStarting] = useState(false);
  const [canRunEnquiryTransfer, setCanRunEnquiryTransfer] = useState(true);
  const [effectiveTeamType, setEffectiveTeamType] = useState<TeamType | null>(null);
  const [lastRun, setLastRun] = useState<{
    id: string;
    status: string;
    startedAt: string;
    endedAt: string | null;
    runParams?: { metrics?: { processed?: number } } | null;
  } | null>(null);

  useEffect(() => {
    if (!token) return;
    void apiFetch<{
      id: string;
      username: string;
      email: string;
      role: string;
      dealerId: string | null;
      canRunEnquiryTransfer?: boolean;
      effectiveTeamType?: TeamType | null;
      teamType?: TeamType | null;
      displayName?: string | null;
      displayLabel?: string;
      avatarUrl?: string | null;
    }>("/v1/me", { token })
      .then((me) => {
        setCanRunEnquiryTransfer(me.canRunEnquiryTransfer !== false);
        setEffectiveTeamType(me.effectiveTeamType ?? null);
        const cur = useAuthStore.getState().user;
        if (cur) syncUserFromApi({ ...cur, ...me });
      })
      .catch(() => {
        setCanRunEnquiryTransfer(true);
        setEffectiveTeamType(null);
      });
  }, [token, syncUserFromApi]);

  useEffect(() => {
    if (!token) return;
    void Promise.all([
      apiFetch<{ id: string; name: string }[]>("/v1/dealers", { token }),
      apiFetch<GdmsAccountSummary>("/v1/gdms-account", { token }).catch(() => null),
    ]).then(([d, gdms]) => {
      setDealers(d);
      setMyGdms(gdms);
      if (user?.dealerId) {
        setDealerId(user.dealerId);
      } else if (d[0]) {
        setDealerId((prev) => prev || d[0]!.id);
      }
    });
  }, [token, user?.dealerId]);

  useEffect(() => {
    if (!token || !dealerId) return;
    void apiFetch<{ lastRun: typeof lastRun }>(
      `/v1/workflow-runs/summary?dealerId=${encodeURIComponent(dealerId)}`,
      { token },
    )
      .then((s) => setLastRun(s.lastRun))
      .catch(() => setLastRun(null));
  }, [token, dealerId]);

  useEffect(() => {
    if (!token || !dealerId) return;
    void apiFetch<{ clearedRunIds?: string[] }>("/v1/workflow-runs/reconcile-stale", {
      method: "POST",
      token,
      body: JSON.stringify({ dealerId }),
    }).catch(() => {});
  }, [token, dealerId]);

  useEffect(() => {
    if (!token || !dealerId || !canEditScheduleSettings(user?.role)) return;
    void Promise.all([
      apiFetch<{
        followUpSkipEnabled: boolean;
        followUpSkipStartTime: string | null;
        lostInquiryEnabled: boolean;
        lostInquiryStartTime: string | null;
      }>(
        `/v1/dealers/${encodeURIComponent(dealerId)}/automation-settings`,
        { token },
      ),
      apiFetch<{ id: string; status: string; runParams?: { operation?: string } | null }[]>(
        `/v1/workflow-runs?dealerId=${encodeURIComponent(dealerId)}`,
        { token },
      ),
    ])
      .then(([settings, runs]) => {
        setFollowUpSkipEnabled(settings.followUpSkipEnabled);
        setFollowUpSkipStartTime(settings.followUpSkipStartTime);
        setLostInquiryEnabled(settings.lostInquiryEnabled);
        setLostInquiryStartTime(settings.lostInquiryStartTime);
        setFollowUpSkipInFlight(
          runs.some(
            (r) =>
              r.runParams?.operation === "follow_up_skip" &&
              ["PENDING", "RUNNING", "PAUSED_OTP", "PAUSED_USER"].includes(r.status),
          ),
        );
        setLostInquiryInFlight(
          runs.some(
            (r) =>
              r.runParams?.operation === "lost_inquiry" &&
              ["PENDING", "RUNNING", "PAUSED_OTP", "PAUSED_USER"].includes(r.status),
          ),
        );
      })
      .catch(() => {
        setFollowUpSkipEnabled(false);
        setFollowUpSkipStartTime(null);
        setLostInquiryEnabled(false);
        setLostInquiryStartTime(null);
        setFollowUpSkipInFlight(false);
        setLostInquiryInFlight(false);
      });
  }, [token, dealerId, user?.role]);

  const selectedGdms = myGdms;
  const showFollowUpSkip = canEditScheduleSettings(user?.role);
  const dealerName =
    dealers.find((d) => d.id === dealerId)?.name ?? dealers[0]?.name ?? null;
  const showDealerPicker = dealers.length > 1;

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

  async function runLostInquiryNow(): Promise<void> {
    if (!token || !dealerId || lostInquiryStarting) return;
    setMsg(null);
    setLostInquiryStarting(true);
    try {
      const res = await apiFetch<{ runId: string; alreadyRunning?: boolean }>(
        `/v1/dealers/${encodeURIComponent(dealerId)}/automation-settings/run-now?operation=lost_inquiry`,
        { method: "POST", token, body: JSON.stringify({}) },
      );
      if (res.alreadyRunning) {
        setMsg("Lost Inquiry is already running — opening Live session.");
      } else {
        setMsg("Lost Inquiry started — opening Live session.");
      }
      setLostInquiryInFlight(true);
      router.push("/live-session");
    } catch (e) {
      setMsg(toUserMessage(e, "generic"));
    } finally {
      setLostInquiryStarting(false);
    }
  }

  async function startLostInquiryManual(): Promise<void> {
    if (starting || !token || !dealerId || !selectedGdms?.configured) return;
    setMsg(null);
    resetLogs();
    setStarting(true);
    try {
      const run = await apiFetch<{ id: string }>("/v1/workflow-runs", {
        method: "POST",
        token,
        body: JSON.stringify({ dealerId, operation: "lost_inquiry", sources: [] }),
      });
      persistAutomationRun({
        runId: run.id,
        dealerId,
        operation: "lost_inquiry",
        sources: [],
      });
      router.push("/live-session");
    } catch (e) {
      setMsg(toUserMessage(e, "generic"));
    } finally {
      setStarting(false);
    }
  }

  async function runFollowUpSkipNow(): Promise<void> {
    if (!token || !dealerId || followUpSkipStarting) return;
    setMsg(null);
    setFollowUpSkipStarting(true);
    try {
      const res = await apiFetch<{ runId: string; alreadyRunning?: boolean }>(
        `/v1/dealers/${encodeURIComponent(dealerId)}/automation-settings/run-now`,
        { method: "POST", token, body: JSON.stringify({}) },
      );
      if (res.alreadyRunning) {
        setMsg("Follow Up Skip is already running — opening Live session.");
      } else {
        setMsg("Follow Up Skip started — opening Live session.");
      }
      setFollowUpSkipInFlight(true);
      router.push("/live-session");
    } catch (e) {
      setMsg(toUserMessage(e, "generic"));
    } finally {
      setFollowUpSkipStarting(false);
    }
  }

  function canResumeSaved(saved: SavedAutomationSession | undefined): boolean {
    if (!saved) return false;
    return Boolean(saved.otpVerifiedAt || saved.gdmsReadyAt);
  }

  async function saveGdmsLoginToken(): Promise<void> {
    if (!token || !dealerId || savingToken) return;
    const raw = gdmsTokenInput.trim();
    if (!raw) {
      setMsg("Paste a GDMS login token (BNES_JSESSIONID from Chrome DevTools).");
      return;
    }
    if (isWorkflowRunId(raw)) {
      setMsg('This looks like a Run ID, not a cookie token. Use "Use GDMS login token" only for BNES_JSESSIONID.');
      return;
    }
    if (!looksLikeGdmsCookieToken(raw)) {
      setMsg(
        "Token is too short or invalid. Log in at ndms.hmil.net, then copy BNES_JSESSIONID from DevTools → Application → Cookies.",
      );
      return;
    }
    setMsg(null);
    setSavingToken(true);
    try {
      await apiFetch("/v1/gdms/login-token", {
        token,
        method: "PUT",
        body: JSON.stringify({ token: raw }),
      });
      setTokenDialogOpen(false);
      setGdmsTokenInput("");
      setMsg("GDMS login token saved. You can press START.");
    } catch (e) {
      setMsg(toUserMessage(e, "generic"));
    } finally {
      setSavingToken(false);
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
    if (fresh && userId) clearSavedSession(userId);
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
          await apiFetch(`/v1/workflow-runs/${body.runId}/requeue`, {
            method: "POST",
            token,
            body: JSON.stringify({}),
          }).catch(() => undefined);
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

  return (
    <>
      <section className="dashboard-section overflow-hidden">
        <div className="border-b border-border/50 bg-muted/20 px-4 py-3 sm:px-6">
          <h2 className="text-sm font-semibold text-foreground">System status</h2>
          <p className="text-xs text-muted-foreground">Credentials, schedules &amp; last run</p>
        </div>
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 sm:gap-4 sm:p-6 xl:grid-cols-4">
          <StatCard
            label="GDMS credentials"
            icon={ShieldCheck}
            variant={selectedGdms?.configured ? "success" : "warning"}
            value={
              selectedGdms?.configured ? (
                <span className="font-mono text-base">{selectedGdms.usernameMasked}</span>
              ) : (
                "Not configured"
              )
            }
          />
          {showFollowUpSkip ? (
            <StatCard
              label="Follow up skip"
              icon={CalendarClock}
              variant={followUpSkipEnabled ? "success" : "muted"}
              value={
                followUpSkipEnabled ? (
                  <span className="font-mono text-base">{followUpSkipStartTime ?? "—"} IST</span>
                ) : (
                  "Disabled"
                )
              }
            />
          ) : null}
          {showFollowUpSkip && lostInquiryEnabled ? (
            <StatCard
              label="Lost inquiry"
              icon={XCircle}
              variant={lostInquiryEnabled ? "warning" : "muted"}
              value={
                lostInquiryEnabled ? (
                  <span className="font-mono text-base">{lostInquiryStartTime ?? "—"} IST Sat</span>
                ) : (
                  "Disabled"
                )
              }
            />
          ) : null}
          <StatCard
            label="Enquiry transfer"
            icon={Zap}
            variant={canRunEnquiryTransfer ? "default" : "muted"}
            value={
              canRunEnquiryTransfer
                ? effectiveTeamType
                  ? TEAM_TYPE_LABELS[effectiveTeamType]
                  : "Available"
                : "Not on your plan"
            }
          />
          <StatCard
            label="Last run"
            icon={History}
            variant={lastRun?.status === "COMPLETED" ? "success" : lastRun ? "default" : "muted"}
            value={lastRun ? lastRun.status.replace(/_/g, " ") : "None yet"}
            hint={
              lastRun
                ? `${new Date(lastRun.startedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST${
                    lastRun.runParams?.metrics?.processed != null
                      ? ` · ${lastRun.runParams.metrics.processed} processed`
                      : ""
                  }`
                : undefined
            }
          />
        </div>
      </section>

      {savedSession && canResumeSaved(savedSession) ? (
        <div className="panel-info">
          <p className="font-medium">Saved automation session</p>
          <p className="mt-1 font-mono text-xs text-foreground">{savedSession.runId}</p>
          <p className="text-sm text-foreground">{OPERATION_LABELS[savedSession.operation]}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" disabled={resuming} onClick={() => void resumeSession()}>
              {resuming ? "Resuming…" : "Resume saved session"}
            </Button>
            {savedSession.operation === "enquiry_transfer" ? (
              <Button
                size="sm"
                variant="outline"
                className="border-info/30 bg-card"
                disabled={starting}
                onClick={() => void start(true)}
              >
                Start fresh (new run)
              </Button>
            ) : null}
            <Link
              href="/live-session"
              className="inline-flex items-center text-sm text-primary underline"
            >
              Live session
            </Link>
          </div>
        </div>
      ) : null}

      <SectionBlock title="Workspace">
        <Card>
          <CardContent className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="min-w-[12rem] flex-1 space-y-1.5">
              {showDealerPicker ? (
                <>
                  <label htmlFor="dealer-select" className="text-sm font-medium text-foreground">
                    Dealer
                  </label>
                  <NativeSelect
                    id="dealer-select"
                    value={dealerId}
                    onChange={(e) => setDealerId(e.target.value)}
                  >
                    {dealers.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </NativeSelect>
                </>
              ) : dealerName ? (
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Dealer</p>
                  <p className="text-base font-semibold text-foreground">{dealerName}</p>
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1 sm:pt-6">
              {selectedGdms?.configured ? (
                <Badge variant="success">GDMS connected</Badge>
              ) : (
                <Badge variant="warning">GDMS required</Badge>
              )}
              <Button variant="outline" size="sm" asChild>
                <Link href="/settings">Open settings</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </SectionBlock>

      <Dialog open={tokenDialogOpen} onOpenChange={setTokenDialogOpen}>
        <DialogContent>
          <DialogTitle>Use GDMS login token</DialogTitle>
          <div className="mt-4 space-y-1.5">
            <Label htmlFor="gdms-token-dialog">GDMS login token (BNES_JSESSIONID)</Label>
            <Input
              id="gdms-token-dialog"
              placeholder="Session cookie"
              value={gdmsTokenInput}
              onChange={(e) => setGdmsTokenInput(e.target.value)}
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setTokenDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={savingToken || !dealerId || !gdmsTokenInput.trim()}
              onClick={() => void saveGdmsLoginToken()}
            >
              {savingToken ? "Saving…" : "Save token"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {showFollowUpSkip ? (
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle>Follow up skip (scheduled)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-foreground">
            {followUpSkipEnabled ? (
              <div className="panel-success">
                <p className="font-medium text-foreground">
                  <span className="font-mono">{followUpSkipStartTime ?? "—"}</span> IST
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {followUpSkipInFlight ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href="/live-session">Live session</Link>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={followUpSkipStarting || !selectedGdms?.configured}
                      onClick={() => void runFollowUpSkipNow()}
                    >
                      {followUpSkipStarting ? "Starting…" : "Run now (missed schedule)"}
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <Badge variant="secondary">Disabled</Badge>
            )}
          </CardContent>
        </Card>
      ) : null}

      {showFollowUpSkip ? (
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle>Lost inquiry (scheduled)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-foreground">
            {lostInquiryEnabled ? (
              <div className="panel-success">
                <p className="font-medium text-foreground">
                  Saturdays <span className="font-mono">{lostInquiryStartTime ?? "—"}</span> IST
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {lostInquiryInFlight ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href="/live-session">Live session</Link>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={lostInquiryStarting || !selectedGdms?.configured}
                      onClick={() => void runLostInquiryNow()}
                    >
                      {lostInquiryStarting ? "Starting…" : "Run now (missed schedule)"}
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <Badge variant="secondary">Disabled — enable in Settings</Badge>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Lost inquiry</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Process Today&apos;s Follow Up rows marked Lost (Digital &amp; Field teams).
          </p>
          <Button
            disabled={starting || lostInquiryInFlight || !selectedGdms?.configured}
            onClick={() => void startLostInquiryManual()}
          >
            {starting ? "Starting…" : "START Lost Inquiry"}
          </Button>
          {lostInquiryInFlight ? (
            <Button asChild size="sm" variant="outline">
              <Link href="/live-session">Open Live session</Link>
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {canRunEnquiryTransfer ? (
          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle>Enquiry transfer</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="operation">Operation</Label>
                <NativeSelect
                  id="operation"
                  value={operation}
                  onChange={(e) => onOperationChange(e.target.value)}
                >
                  <option value="">Select operation…</option>
                  {DASHBOARD_MANUAL_OPERATIONS.map((op) => (
                    <option key={op} value={op}>
                      {OPERATION_LABELS[op]}
                    </option>
                  ))}
                </NativeSelect>
              </div>

              {operation && operationNeedsSources(operation) ? (
                <div className="space-y-1.5">
                  <Label>Sources</Label>
                  <div className="rounded border border-border p-2">
                    <ul className="flex flex-col gap-1.5">
                      {AUTOMATION_SOURCES.map((source) => (
                        <li key={source}>
                          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                            <input
                              type="checkbox"
                              className="rounded border-border"
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
                  <div className="rounded border border-border p-2">
                    <ul className="flex flex-col gap-1.5">
                      {SUB_SOURCES_BY_PARENT[parent].map((sub) => (
                        <li key={sub}>
                          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                            <input
                              type="checkbox"
                              className="rounded border-border"
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

              <div className="flex flex-col gap-3">
                <Button disabled={!canStart || starting} onClick={() => void start()}>
                  {starting ? "Starting…" : "START (new run)"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={!dealerId || savingToken}
                  onClick={() => setTokenDialogOpen(true)}
                >
                  Use GDMS login token (skip OTP)
                </Button>
              </div>
              {!selectedGdms?.configured && operation ? (
                <Badge variant="warning">GDMS required</Badge>
              ) : null}
              {msg ? (
                <p className="text-sm text-warning">
                  {msg}
                  {msg.toLowerCase().includes("already running") ? (
                    <>
                      {" "}
                      <Link className="font-medium underline" href="/live-session">
                        Live session
                      </Link>
                    </>
                  ) : null}
                </p>
              ) : null}
            </CardContent>
          </Card>
        ) : (
          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle>Enquiry transfer</CardTitle>
            </CardHeader>
            <CardContent>
              <Badge variant="secondary">Field plan</Badge>
            </CardContent>
          </Card>
        )}

        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle>Quick links</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {[
              { href: "/live-session", label: "Live automation viewer" },
              { href: "/dashboard", label: "Analytics dashboard" },
              { href: "/leads", label: "Leads panel" },
              { href: "/settings", label: "Settings & GDMS" },
            ].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-primary/30 hover:bg-accent"
              >
                {item.label}
                <span className="text-muted-foreground" aria-hidden>
                  →
                </span>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
