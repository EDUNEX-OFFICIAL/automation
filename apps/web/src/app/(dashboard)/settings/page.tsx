"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GdmsSavedCredentials } from "@/components/gdms-saved-credentials";
import { StatusBanner } from "@/components/ui/status-banner";
import { apiFetch } from "@/lib/api";
import type { GdmsAccountSummary } from "@/lib/gdms-account";
import { toUserMessage } from "@/lib/user-messages";
import { useAuthStore } from "@/stores/auth-store";
import type { UserInfo } from "@/stores/auth-store";
import type { DealerAutomationSettingsPayload } from "@gdms/shared";

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
  const storeLogout = useAuthStore((s) => s.logout);

  const [dealerId, setDealerId] = useState("");
  const [dealers, setDealers] = useState<{ id: string; name: string }[]>([]);
  const [gdmsAccounts, setGdmsAccounts] = useState<GdmsAccountSummary[]>([]);
  const [gdmsListLoading, setGdmsListLoading] = useState(false);
  const [bootstrapPending, setBootstrapPending] = useState(false);
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

  useEffect(() => {
    if (!token) router.replace("/login");
  }, [token, router]);

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
        const dealerList = await apiFetch<{ id: string; name: string }[]>("/v1/dealers", { token });
        if (cancelled) return;
        setDealers(dealerList);
        if (cancelled) return;
        setDealerId(id);
        if (!id)
          setErrMsg("We couldn't set up your dealer. Refresh the page or contact your administrator.");
        else {
          await refreshGdmsList(token, cancelled);
          if (id && !cancelled) {
            try {
              const settings = await apiFetch<DealerAutomationSettingsPayload>(
                `/v1/dealers/${id}/automation-settings`,
                { token },
              );
              if (!cancelled) {
                setFollowUpSkipEnabled(settings.followUpSkipEnabled);
                setFollowUpSkipStartTime(settings.followUpSkipStartTime ?? "09:00");
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

  async function refreshGdmsList(tk: string, cancelled?: boolean): Promise<void> {
    setGdmsListLoading(true);
    try {
      const list = await apiFetch<GdmsAccountSummary[]>("/v1/gdms-accounts", { token: tk });
      if (!cancelled) setGdmsAccounts(list);
    } catch (e) {
      if (!cancelled) setErrMsg(toUserMessage(e, "generic"));
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

      const saved = await apiFetch<GdmsAccountSummary & { id: string }>("/v1/gdms-account", {
        method: "PUT",
        token: tk,
        body: JSON.stringify({
          dealerId: id,
          username: gdmsUser.trim(),
          password: gdmsPass.trim(),
        }),
      });
      setGdmsAccounts((prev) => {
        const next = prev.filter((a) => a.dealerId !== saved.dealerId);
        return [...next, saved].sort((a, b) => a.dealerName.localeCompare(b.dealerName));
      });
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

  async function signOut(): Promise<void> {
    setErrMsg(null);
    try {
      await apiFetch("/v1/auth/logout", { method: "POST" });
    } catch {
      /* cookie clear best-effort */
    }
    storeLogout();
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
    setAutomationSettingsSaving(true);
    try {
      const saved = await apiFetch<
        DealerAutomationSettingsPayload & { stoppedRunIds?: string[] }
      >(`/v1/dealers/${dealerId}/automation-settings`, {
        method: "PUT",
        token: tk,
        body: JSON.stringify({
          followUpSkipEnabled,
          followUpSkipStartTime: followUpSkipEnabled ? followUpSkipStartTime.trim() : null,
        }),
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
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-zinc-600">
          {bootstrapPending ? "Loading session…" : "Could not load your profile. See the error below or sign in again."}
        </p>
        {errMsg && <p className="text-sm text-red-600">{errMsg}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <GdmsSavedCredentials
        accounts={gdmsAccounts}
        loading={gdmsListLoading || bootstrapPending}
        selectedDealerId={dealerId}
        onSelectDealer={
          user.role === "SUPER_ADMIN" && dealers.length > 1 ? (id) => setDealerId(id) : undefined
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>GDMS account</CardTitle>
        </CardHeader>
        <CardContent className="max-w-xl space-y-3">
          {bootstrapPending && (
            <p className="text-xs text-zinc-500">Loading dealer context…</p>
          )}
          {user.role === "SUPER_ADMIN" && dealers.length > 1 && (
            <div>
              <Label>Dealer</Label>
              <select
                className="mt-1 w-full rounded border border-zinc-200 px-2 py-2 text-sm"
                value={dealerId}
                onChange={(e) => setDealerId(e.target.value)}
              >
                {dealers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <Label>GDMS username</Label>
            <Input value={gdmsUser} onChange={(e) => setGdmsUser(e.target.value)} />
          </div>
          <div>
            <Label>GDMS password</Label>
            <Input type="password" value={gdmsPass} onChange={(e) => setGdmsPass(e.target.value)} />
          </div>
          {gdmsSaveOk && (
            <StatusBanner variant="success" title="Credentials saved">
              Your GDMS login is stored securely. You can start automation from the Dashboard.
            </StatusBanner>
          )}
          {errMsg && (
            <StatusBanner variant="error" title="Could not save">
              {errMsg}
            </StatusBanner>
          )}
          <Button
            disabled={bootstrapPending || !dealerId || gdmsSaving}
            onClick={() => void saveGdms()}
          >
            {gdmsSaving ? "Saving…" : gdmsSaveOk ? "Saved — update again" : "Save credentials"}
          </Button>
          {!bootstrapPending && !dealerId && (
            <p className="text-xs text-amber-700">
              Dealer context is missing. Refresh the page or sign in again.
            </p>
          )}
        </CardContent>
      </Card>

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
            className="min-h-[180px] w-full rounded border border-zinc-200 p-2 font-mono text-xs"
            value={workflowJson}
            onChange={(e) => setWorkflowJson(e.target.value)}
          />
          {workflowSaveOk && (
            <StatusBanner variant="success" title="Workflow saved">
              Your workflow definition was stored for this dealer.
            </StatusBanner>
          )}
          <Button variant="outline" disabled={bootstrapPending || !dealerId} onClick={() => void saveWorkflow()}>
            Save workflow
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Follow Up Skip (Today&apos;s Follow Up)</CardTitle>
        </CardHeader>
        <CardContent className="max-w-xl space-y-4">
          <p className="text-sm text-zinc-600">
            Daily automation: GDMS → car icon → Booking/Retail Mgt → Today&apos;s Follow Up → Search → saves
            follow-up on each row. Can run in parallel with enquiry transfer in a separate browser.
          </p>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="rounded border-zinc-300"
              checked={followUpSkipEnabled}
              onChange={(e) => setFollowUpSkipEnabled(e.target.checked)}
            />
            Follow Up Skip enabled
          </label>
          <p className="text-xs text-zinc-500">
            Disabling the toggle immediately force-stops any running Follow Up Skip automation.
          </p>
          {followUpSkipEnabled ? (
            <div className="space-y-1.5">
              <Label htmlFor="follow-up-skip-time">Daily start time (IST, 24h)</Label>
              <Input
                id="follow-up-skip-time"
                type="time"
                value={followUpSkipStartTime}
                onChange={(e) => setFollowUpSkipStartTime(e.target.value)}
              />
              <p className="text-xs text-zinc-500">
                Automation starts at this time every day until you disable it or change the time.
              </p>
            </div>
          ) : null}
          {automationSettingsOk ? (
            <StatusBanner variant="success" title="Automation settings saved">
              Follow Up Skip schedule updated.
            </StatusBanner>
          ) : null}
          <Button
            disabled={bootstrapPending || !dealerId || automationSettingsSaving}
            onClick={() => void saveAutomationSettings()}
          >
            {automationSettingsSaving ? "Saving…" : "Save automation settings"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI calling (Ollama model hint)</CardTitle>
        </CardHeader>
        <CardContent>
          <Input value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} />
          <p className="mt-2 text-xs text-zinc-500">
            The ai-service uses OLLAMA_MODEL on the server. This field is for reference only.
          </p>
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

      <Card>
        <CardHeader>
          <CardTitle>Session</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-zinc-500">
            Long-lived access tokens and refresh cookies keep you signed in. Sign out from here.
          </p>
          <Button variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </CardContent>
      </Card>

      {pairMsg && !gdmsSaveOk && !workflowSaveOk && (
        <StatusBanner variant="success" title="Done">
          {pairMsg}
        </StatusBanner>
      )}
    </div>
  );
}
