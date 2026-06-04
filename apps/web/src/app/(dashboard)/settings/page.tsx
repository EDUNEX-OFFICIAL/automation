"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsTabs } from "@/components/settings-tabs";
import { PageHeader } from "@/components/ui/page-header";
import { GdmsSavedCredentials } from "@/components/gdms-saved-credentials";
import { StatusBanner } from "@/components/ui/status-banner";
import { apiFetch } from "@/lib/api";
import type { GdmsAccountSummary } from "@/lib/gdms-account";
import { toUserMessage } from "@/lib/user-messages";
import { canEditScheduleSettings } from "@/lib/roles";
import { signOut as authSignOut } from "@/lib/auth-session";
import { useAuthStore } from "@/stores/auth-store";
import type { UserInfo } from "@/stores/auth-store";
import {
  RemarkSettingsCards,
  type RemarkSettingsFormState,
} from "@/components/remark-settings-cards";
import type {
  DealerAutomationSettingsPayload,
  DealerAutomationSettingsResponse,
} from "@gdms/shared";

async function resolveDealerIdForUser(token: string, user: UserInfo): Promise<string> {
  let list = await apiFetch<{ id: string; name: string }[]>("/v1/dealers", { token });
  if (user.role === "SUPER_ADMIN" && list.length === 0) {
    const created = await apiFetch<{ id: string; name: string }>("/v1/dealers", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "Default dealer" }),
    });
    list = [created];
  }
  return user.dealerId ?? list[0]?.id ?? "";
}

export default function SettingsPage() {
  const router = useRouter();
  const token = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const syncUserFromApi = useAuthStore((s) => s.syncUserFromApi);

  const [dealerId, setDealerId] = useState("");
  const [gdmsAccounts, setGdmsAccounts] = useState<GdmsAccountSummary[]>([]);
  const [gdmsListLoading, setGdmsListLoading] = useState(false);
  const [bootstrapPending, setBootstrapPending] = useState(false);
  const [editUserId, setEditUserId] = useState("");
  const [gdmsUser, setGdmsUser] = useState("");
  const [gdmsPass, setGdmsPass] = useState("");
  const [workflowName, setWorkflowName] = useState("gdms_login");
  const [workflowJson, setWorkflowJson] = useState(`{"version":"1","name":"custom","steps":[]}`);
  const [gdmsSaveOk, setGdmsSaveOk] = useState(false);
  const [gdmsSaving, setGdmsSaving] = useState(false);
  const [workflowSaveOk, setWorkflowSaveOk] = useState(false);
  const [pairMsg, setPairMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [ollamaModel, setOllamaModel] = useState("llama3.2");
  const [followUpSkipEnabled, setFollowUpSkipEnabled] = useState(false);
  const [followUpSkipStartTime, setFollowUpSkipStartTime] = useState("09:00");
  const [automationSettingsOk, setAutomationSettingsOk] = useState(false);
  const [automationSettingsSaving, setAutomationSettingsSaving] = useState(false);
  const [canEditRemarks, setCanEditRemarks] = useState(false);
  const [remarkSettings, setRemarkSettings] = useState<RemarkSettingsFormState>({
    defaultEnquiryRemarkBase: "Call Back",
    enquiryRemarkRules: [],
    followUpSkipRemarkBases: [],
  });
  const [settingsTab, setSettingsTab] = useState("gdms");

  const showRemarkSettings =
    user?.role === "TEAM_LEADER" || user?.role === "DEALER_ADMIN";
  const showScheduleSettings = canEditScheduleSettings(user?.role);
  const showWorkflowsTab = user?.role === "DEALER_ADMIN";
  const showAiTab = user?.role === "DEALER_ADMIN";

  useEffect(() => {
    if (!token) router.replace("/login");
  }, [token, router]);

  useEffect(() => {
    if (!user) return;
    const allowed = new Set([
      "gdms",
      ...(showScheduleSettings ? ["schedule"] : []),
      ...(showRemarkSettings ? ["remarks"] : []),
      ...(showWorkflowsTab ? ["workflows"] : []),
      ...(showAiTab ? ["ai"] : []),
    ]);
    if (!allowed.has(settingsTab)) setSettingsTab("gdms");
  }, [user, settingsTab, showScheduleSettings, showRemarkSettings, showWorkflowsTab, showAiTab]);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;

    void (async () => {
      setBootstrapPending(true);
      try {
        setErrMsg(null);
        let u = user;
        if (!u) {
          u = await apiFetch<UserInfo>("/v1/me", { token });
          if (cancelled) return;
          syncUserFromApi(u);
        }
        const id = await resolveDealerIdForUser(token, u);
        if (cancelled) return;
        setDealerId(id);
        if (!id)
          setErrMsg("We couldn't set up your dealer. Refresh the page or contact your administrator.");
        else {
          if (u.role === "TEAM_LEADER" || u.role === "SALES_CONSULTANT") {
            setEditUserId(u.id);
          }
          const list = await refreshGdmsList(token, cancelled);
          if (!cancelled && u.role === "DEALER_ADMIN" && list.length > 0) {
            setEditUserId((prev) => prev || list[0]!.userId);
          }
          if (id && !cancelled) {
            try {
              const settings = await apiFetch<DealerAutomationSettingsResponse>(
                `/v1/dealers/${id}/automation-settings`,
                { token },
              );
              if (!cancelled) {
                setFollowUpSkipEnabled(settings.followUpSkipEnabled);
                setFollowUpSkipStartTime(settings.followUpSkipStartTime ?? "09:00");
                setOllamaModel(settings.ollamaModel ?? "llama3.2");
                setCanEditRemarks(settings.canEditRemarks);
                setRemarkSettings({
                  defaultEnquiryRemarkBase: settings.defaultEnquiryRemarkBase,
                  enquiryRemarkRules: settings.enquiryRemarkRules,
                  followUpSkipRemarkBases: settings.followUpSkipRemarkBases,
                });
              }
            } catch {
              /* optional */
            }
          }
        }
      } catch (e) {
        if (!cancelled) setErrMsg(toUserMessage(e, "generic"));
      } finally {
        if (!cancelled) setBootstrapPending(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, user, syncUserFromApi]);

  async function refreshGdmsList(tk: string, cancelled?: boolean): Promise<GdmsAccountSummary[]> {
    setGdmsListLoading(true);
    try {
      const list = await apiFetch<GdmsAccountSummary[]>("/v1/gdms-accounts", { token: tk });
      if (!cancelled) setGdmsAccounts(list);
      return list;
    } catch (e) {
      if (!cancelled) setErrMsg(toUserMessage(e, "generic"));
      return [];
    } finally {
      if (!cancelled) setGdmsListLoading(false);
    }
  }

  async function saveGdms(): Promise<void> {
    setErrMsg(null);
    setGdmsSaveOk(false);
    setPairMsg(null);
    const tk = token;
    if (!tk || !user) {
      setErrMsg("Your session expired. Please sign in again.");
      return;
    }

    setGdmsSaving(true);
    try {
      const id =
        dealerId ||
        (await resolveDealerIdForUser(tk, useAuthStore.getState().user ?? user));

      setDealerId(id);
      if (!id) {
        setErrMsg("We couldn't find your dealer. Refresh the page and try again.");
        return;
      }

      if (!gdmsUser.trim() || !gdmsPass) {
        setErrMsg("Please enter both your GDMS username and password.");
        return;
      }

      const targetUserId =
        user.role === "DEALER_ADMIN" ? editUserId || user.id : user.id;
      if (!targetUserId) {
        setErrMsg("Select a team member to set GDMS credentials for.");
        return;
      }

      const saved = await apiFetch<GdmsAccountSummary & { id: string }>("/v1/gdms-account", {
        method: "PUT",
        token: tk,
        body: JSON.stringify({
          userId: targetUserId,
          username: gdmsUser.trim(),
          password: gdmsPass.trim(),
        }),
      });
      await refreshGdmsList(tk);
      setEditUserId(saved.userId);
      setGdmsSaveOk(true);
      setGdmsPass("");
      setGdmsUser("");
    } catch (e) {
      setErrMsg(toUserMessage(e, "generic"));
    } finally {
      setGdmsSaving(false);
    }
  }

  async function saveWorkflow(): Promise<void> {
    setErrMsg(null);
    setPairMsg(null);
    const tk = token;
    const u = useAuthStore.getState().user ?? user;
    if (!tk || !u) return;
    try {
      const id = dealerId || (await resolveDealerIdForUser(tk, u));
      setDealerId(id);
      if (!id) {
        setErrMsg("Dealer context missing.");
        return;
      }
      const def = JSON.parse(workflowJson) as object;
      await apiFetch("/v1/workflows", {
        method: "POST",
        token: tk,
        body: JSON.stringify({ dealerId: id, name: workflowName, version: "1", definition: def }),
      });
      setWorkflowSaveOk(true);
      setPairMsg("Workflow saved.");
    } catch (e) {
      setErrMsg(toUserMessage(e, "generic"));
    }
  }

  async function handleSignOut(): Promise<void> {
    setErrMsg(null);
    await authSignOut();
    router.replace("/login");
  }

  async function saveAutomationSettings(): Promise<void> {
    setErrMsg(null);
    setAutomationSettingsOk(false);
    const tk = token;
    if (!tk || !dealerId) {
      setErrMsg("Dealer context missing.");
      return;
    }
    if (followUpSkipEnabled && !followUpSkipStartTime.trim()) {
      setErrMsg("Set a daily start time for Follow Up Skip (IST).");
      return;
    }
    if (canEditRemarks) {
      const badRule = remarkSettings.enquiryRemarkRules.find((r) => !r.remarkBase.trim());
      if (badRule) {
        setErrMsg("Fill in every enquiry remark rule or remove empty rows.");
        return;
      }
      const badSkip = remarkSettings.followUpSkipRemarkBases.find((b) => !b.trim());
      if (badSkip) {
        setErrMsg("Fill in every Follow Up Skip remark or remove empty rows.");
        return;
      }
    }
    setAutomationSettingsSaving(true);
    try {
      const payload: DealerAutomationSettingsPayload = {
        followUpSkipEnabled,
        followUpSkipStartTime: followUpSkipEnabled ? followUpSkipStartTime.trim() : null,
        ollamaModel: ollamaModel.trim() || null,
      };
      if (canEditRemarks) {
        payload.defaultEnquiryRemarkBase = remarkSettings.defaultEnquiryRemarkBase;
        payload.enquiryRemarkRules = remarkSettings.enquiryRemarkRules;
        payload.followUpSkipRemarkBases = remarkSettings.followUpSkipRemarkBases.filter(
          (b) => b.trim().length > 0,
        );
      }
      const saved = await apiFetch<
        DealerAutomationSettingsResponse & { stoppedRunIds?: string[] }
      >(`/v1/dealers/${dealerId}/automation-settings`, {
        method: "PUT",
        token: tk,
        body: JSON.stringify(payload),
      });
      setRemarkSettings({
        defaultEnquiryRemarkBase: saved.defaultEnquiryRemarkBase,
        enquiryRemarkRules: saved.enquiryRemarkRules,
        followUpSkipRemarkBases: saved.followUpSkipRemarkBases,
      });
      setAutomationSettingsOk(true);
      setPairMsg(null);
      if (!followUpSkipEnabled && (saved.stoppedRunIds?.length ?? 0) > 0) {
        setPairMsg(
          `Follow Up Skip disabled — force-stopped ${saved.stoppedRunIds!.length} running automation(s).`,
        );
      }
    } catch (e) {
      setErrMsg(toUserMessage(e, "generic"));
    } finally {
      setAutomationSettingsSaving(false);
    }
  }

  async function pairAndroid(): Promise<void> {
    setErrMsg(null);
    setPairMsg(null);
    const tk = token;
    const u = useAuthStore.getState().user ?? user;
    if (!tk || !u) return;
    try {
      const id = dealerId || (await resolveDealerIdForUser(tk, u));
      setDealerId(id);
      if (!id) {
        setErrMsg("Dealer context missing.");
        return;
      }
      const res = await apiFetch<{ pairingCode: string }>("/v1/android/pair", {
        method: "POST",
        token: tk,
        body: JSON.stringify({ dealerId: id }),
      });
      setPairMsg(`Android pairing code: ${res.pairingCode} (10 min valid)`);
    } catch (e) {
      setErrMsg(String(e));
    }
  }

  if (!token) return null;

  if (!user) {
    return (
      <div className="space-y-6">
        <PageHeader title="Settings" />
        {errMsg ? <p className="text-sm text-destructive">{errMsg}</p> : null}
      </div>
    );
  }

  return (
    <>
      <PageHeader title="Settings" eyebrow="Configuration" />

      <SettingsTabs
        active={settingsTab}
        onChange={setSettingsTab}
        tabs={[
          { id: "gdms", label: "GDMS" },
          ...(showScheduleSettings ? [{ id: "schedule", label: "Schedule" }] : []),
          ...(showRemarkSettings ? [{ id: "remarks", label: "Remarks" }] : []),
          ...(showWorkflowsTab ? [{ id: "workflows", label: "Workflows" }] : []),
          ...(showAiTab ? [{ id: "ai", label: "AI calling" }] : []),
        ]}
      />

      {(user.role === "DEALER_ADMIN" ||
        user.role === "TEAM_LEADER" ||
        user.role === "SALES_CONSULTANT") && (
        <>
          {(settingsTab === "gdms" || settingsTab === "schedule" || settingsTab === "remarks") && (
          <>
          {settingsTab === "gdms" ? (
          <>
          <GdmsSavedCredentials
            accounts={gdmsAccounts}
            loading={gdmsListLoading || bootstrapPending}
            selectedUserId={editUserId}
            onSelectUser={
              user.role === "DEALER_ADMIN"
                ? (uid) => {
                    setEditUserId(uid);
                    setGdmsSaveOk(false);
                  }
                : undefined
            }
            title={
              user.role === "DEALER_ADMIN"
                ? "Team GDMS credentials"
                : "Your GDMS credentials"
            }
          />

          <Card>
            <CardHeader>
              <CardTitle>
                {user.role === "DEALER_ADMIN" && editUserId
                  ? `GDMS login — ${
                      gdmsAccounts.find((a) => a.userId === editUserId)?.username ?? "team member"
                    }`
                  : "Your GDMS login"}
              </CardTitle>
            </CardHeader>
            <CardContent className="max-w-xl space-y-3">
              <div>
                <Label htmlFor="gdms-portal-username">GDMS username</Label>
                <Input
                  id="gdms-portal-username"
                  suppressAutofill
                  autofillFieldKey="gdms-portal-username"
                  value={gdmsUser}
                  onChange={(e) => setGdmsUser(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="gdms-portal-password">GDMS password</Label>
                <Input
                  id="gdms-portal-password"
                  type="password"
                  suppressAutofill
                  autofillFieldKey="gdms-portal-password"
                  value={gdmsPass}
                  onChange={(e) => setGdmsPass(e.target.value)}
                />
              </div>
              {gdmsSaveOk && (
                <StatusBanner variant="success" title="Credentials saved" />
              )}
              {errMsg && (
                <StatusBanner variant="error" title="Could not save">
                  {errMsg}
                </StatusBanner>
              )}
              <Button
                disabled={bootstrapPending || gdmsSaving || (user.role === "DEALER_ADMIN" && !editUserId)}
                onClick={() => void saveGdms()}
              >
                {gdmsSaving ? "Saving…" : gdmsSaveOk ? "Saved — update again" : "Save credentials"}
              </Button>
            </CardContent>
          </Card>
          </>
          ) : null}

          {settingsTab === "remarks" && showRemarkSettings ? (
            <RemarkSettingsCards
              value={remarkSettings}
              onChange={setRemarkSettings}
              disabled={bootstrapPending || automationSettingsSaving}
            />
          ) : null}

          {settingsTab === "schedule" && showScheduleSettings ? (
          <Card>
            <CardHeader>
              <CardTitle>Follow Up Skip (Today&apos;s Follow Up)</CardTitle>
            </CardHeader>
            <CardContent className="max-w-xl space-y-4">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="rounded border-border"
                  checked={followUpSkipEnabled}
                  onChange={(e) => setFollowUpSkipEnabled(e.target.checked)}
                />
                Follow Up Skip enabled
              </label>
              {followUpSkipEnabled ? (
                <div className="space-y-1.5">
                  <Label htmlFor="follow-up-skip-time">Daily start time (IST, 24h)</Label>
                  <Input
                    id="follow-up-skip-time"
                    type="time"
                    value={followUpSkipStartTime}
                    onChange={(e) => setFollowUpSkipStartTime(e.target.value)}
                  />
                </div>
              ) : null}
              {automationSettingsOk ? (
                <StatusBanner variant="success" title="Automation settings saved" />
              ) : null}
              <Button
                disabled={bootstrapPending || !dealerId || automationSettingsSaving}
                onClick={() => void saveAutomationSettings()}
              >
                {automationSettingsSaving ? "Saving…" : "Save automation settings"}
              </Button>
            </CardContent>
          </Card>
          ) : null}
          </>
          )}
        </>
      )}

      {user.role === "DEALER_ADMIN" && settingsTab === "workflows" && (
      <>
      <Card>
        <CardHeader>
          <CardTitle>Workflow JSON (versioned)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label>Workflow name key</Label>
            <Input value={workflowName} onChange={(e) => setWorkflowName(e.target.value)} />
          </div>
          <textarea
            className="min-h-[180px] w-full rounded-lg border border-input bg-muted/30 p-3 font-mono text-xs"
            value={workflowJson}
            onChange={(e) => setWorkflowJson(e.target.value)}
          />
          {workflowSaveOk && <StatusBanner variant="success" title="Workflow saved" />}
          <Button variant="outline" disabled={bootstrapPending || !dealerId} onClick={() => void saveWorkflow()}>
            Save workflow
          </Button>
        </CardContent>
      </Card>
      </>
      )}

      {user.role === "DEALER_ADMIN" && settingsTab === "ai" && (
      <>
      <Card>
        <CardHeader>
          <CardTitle>AI calling (Ollama model)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} />
          <Button
            disabled={bootstrapPending || !dealerId || automationSettingsSaving}
            onClick={() => void saveAutomationSettings()}
          >
            Save AI settings
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Android gateway pairing</CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="outline" disabled={bootstrapPending || !dealerId} onClick={() => void pairAndroid()}>
            Generate pairing code
          </Button>
        </CardContent>
      </Card>
      </>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Session</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button variant="outline" onClick={() => void handleSignOut()}>
            Sign out
          </Button>
        </CardContent>
      </Card>

      {pairMsg && !gdmsSaveOk && !workflowSaveOk && (
        <StatusBanner variant="success" title="Done">
          {pairMsg}
        </StatusBanner>
      )}
    </>
  );
}
