"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";
import { useLiveStore } from "@/stores/live-store";

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

  useEffect(() => {
    if (!token) router.replace("/login");
  }, [token, router]);

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

  async function control(action: "pause" | "resume" | "stop"): Promise<void> {
    if (!token || !runId) return;
    await apiFetch(`/v1/workflow-runs/${runId}/control`, {
      method: "POST",
      token,
      body: JSON.stringify({ action }),
    });
  }

  if (!token) return null;

  const statusHint = runRow
    ? `DB status: ${runRow.status}${runRow.errorMessage ? ` — ${runRow.errorMessage}` : ""}`
    : runId
      ? "Run status load nahi hua…"
      : "—";

  const previewHint = !realtimeConnected
    ? "Realtime socket abhi connect nahi — neeche logs dekho (polling transport ab enable hai, page refresh karo)."
    : runRow?.status === "FAILED" || runRow?.status === "STOPPED"
      ? "Run khatam / fail — error neeche DB line + logs me."
      : runRow?.status === "PENDING"
        ? "Queue me PENDING — worker + automation service chalu hon (Redis + Playwright)."
        : "Screenshot abhi tak nahi aaya — thodi der wait karein ya neeche error dekhein.";

  const showPostLogin = workflowDone || runRow?.status === "COMPLETED";

  return (
    <div className="space-y-4">
      {showPostLogin && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-green-900">
          <p className="font-medium">GDMS login / workflow complete</p>
          <p className="mt-1 text-sm text-green-800">
            Neeche browser preview me ab Hyundai DMS ka <strong>logged-in (home / dashboard)</strong> UI dikhna
            chahiye. Agar ab bhi OTP / login form dikhe to automation logs me &quot;final_login&quot; step dekho
            — blue Login click ab role-based + fallback se try hota hai.
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

      {runRow?.status === "RUNNING" && lastStep === "Enter OTP into GDMS" && (
        <p className="text-sm text-amber-800">
          OTP field fill ho chuka — ab blue <strong>Login</strong> click automation se hoga; preview update hone do.
        </p>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Live session</h1>
          <p className="text-sm text-zinc-600">Run: {runId ?? "—"}</p>
          <p className="text-xs text-zinc-500">
            Socket: {realtimeConnected ? "connected" : "disconnected / connecting…"} · {statusHint}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void control("pause")}>
            Pause
          </Button>
          <Button variant="outline" size="sm" onClick={() => void control("resume")}>
            Resume
          </Button>
          <Button size="sm" variant="outline" onClick={() => void control("stop")}>
            Stop
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Browser preview (JPEG stream)</CardTitle>
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
                <p className="text-xs text-zinc-400">
                  Tip: Dashboard se &quot;START — GDMS login&quot; dabao; phir yahan aao — worker, automation (:4101), Redis
                  (+ Playwright Chromium) zaroor hon.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Step / logs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <span className="font-medium">Current step:</span> {lastStep ?? "—"}
            </p>
            <div className="max-h-96 overflow-y-auto rounded bg-zinc-50 p-2 font-mono text-xs">
              {logs.map((l, i) => (
                <div key={`${l.ts}-${i}`}>
                  [{l.level}] {l.message}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
