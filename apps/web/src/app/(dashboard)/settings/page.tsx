"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";
import type { UserInfo } from "@/stores/auth-store";

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
  const [bootstrapPending, setBootstrapPending] = useState(false);
  const [gdmsUser, setGdmsUser] = useState("");
  const [gdmsPass, setGdmsPass] = useState("");
  const [workflowName, setWorkflowName] = useState("gdms_login");
  const [workflowJson, setWorkflowJson] = useState(`{"version":"1","name":"custom","steps":[]}`);
  const [pairMsg, setPairMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [ollamaModel, setOllamaModel] = useState("llama3.2");

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
        if (cancelled) return;
        setDealerId(id);
        if (!id)
          setErrMsg(
            "koi Dealer context nahi — SUPER_ADMIN hone par default dealer banana chahiye; phir bhi issue ho to API logs dekho.",
          );
      } catch (e) {
        if (!cancelled) setErrMsg(String(e));
      } finally {
        if (!cancelled) setBootstrapPending(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, user, syncUserFromApi]);

  async function saveGdms(): Promise<void> {
    setErrMsg(null);
    setPairMsg(null);
    const tk = token;
    if (!tk || !user) {
      setErrMsg("Login / session incomplete — dubara login karo.");
      return;
    }

    try {
      const id =
        dealerId ||
        (await resolveDealerIdForUser(tk, useAuthStore.getState().user ?? user));

      setDealerId(id);
      if (!id) {
        setErrMsg("Dealer id missing — refresh ke baad phir try karo.");
        return;
      }

      if (!gdmsUser.trim() || !gdmsPass) {
        setErrMsg("GDMS username aur password dono zaroori hain.");
        return;
      }

      await apiFetch("/v1/gdms-account", {
        method: "PUT",
        token: tk,
        body: JSON.stringify({ dealerId: id, username: gdmsUser, password: gdmsPass }),
      });
      setPairMsg("GDMS credentials encrypted & saved.");
    } catch (e) {
      setErrMsg(String(e));
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
      setPairMsg("Workflow saved.");
    } catch (e) {
      setErrMsg(String(e));
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
          {bootstrapPending ? "Session load ho rahi hai…" : "User profile load nahi hui — neeche error dekho ya login karo."}
        </p>
        {errMsg && <p className="text-sm text-red-600">{errMsg}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <Card>
        <CardHeader>
          <CardTitle>GDMS account (encrypted)</CardTitle>
        </CardHeader>
        <CardContent className="max-w-xl space-y-3">
          {bootstrapPending && (
            <p className="text-xs text-zinc-500">Dealer context load ho raha hai…</p>
          )}
          <div>
            <Label>GDMS username</Label>
            <Input value={gdmsUser} onChange={(e) => setGdmsUser(e.target.value)} />
          </div>
          <div>
            <Label>GDMS password</Label>
            <Input type="password" value={gdmsPass} onChange={(e) => setGdmsPass(e.target.value)} />
          </div>
          <Button disabled={bootstrapPending || !dealerId} onClick={() => void saveGdms()}>
            Save credentials
          </Button>
          {!bootstrapPending && !dealerId && (
            <p className="text-xs text-amber-700">
              Dealer id missing — reload karo ya upar API error dekho (401 = token expiry).
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
          <Button variant="outline" disabled={bootstrapPending || !dealerId} onClick={() => void saveWorkflow()}>
            Save workflow
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
            Server-side ai-service uses OLLAMA_MODEL env; yahan sirf reference / documentation ke liye.
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
            Access token lambi expiry + refresh cookie se zyada der tak logged-in rahenge. Sign out sirf yahan se.
          </p>
          <Button variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </CardContent>
      </Card>

      {errMsg && <p className="text-sm text-red-600">{errMsg}</p>}
      {pairMsg && <p className="text-sm text-green-700">{pairMsg}</p>}
    </div>
  );
}
