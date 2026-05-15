"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";
import { useLiveStore } from "@/stores/live-store";

export default function DashboardPage() {
  const router = useRouter();
  const token = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const setRun = useLiveStore((s) => s.setRun);
  const resetLogs = useLiveStore((s) => s.resetLogs);
  const [dealers, setDealers] = useState<{ id: string; name: string } []>([]);
  const [dealerId, setDealerId] = useState<string>("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!token) router.replace("/login");
  }, [token, router]);

  useEffect(() => {
    if (!token) return;
    void apiFetch<{ id: string; name: string }[]>("/v1/dealers", { token }).then((d) => {
      setDealers(d);
      if (user?.dealerId) {
        setDealerId(user.dealerId);
      } else if (d[0]) {
        setDealerId((prev) => prev || d[0]!.id);
      }
    });
  }, [token, user?.dealerId]);

  async function start(kind: string): Promise<void> {
    if (!token || !dealerId) {
      setMsg("Pehle dealer select karein / settings se GDMS configure karein.");
      return;
    }
    setMsg(null);
    resetLogs();
    try {
      const run = await apiFetch<{ id: string }>("/v1/workflow-runs", {
        method: "POST",
        token,
        body: JSON.stringify({ dealerId, kind }),
      });
      setRun(run.id);
      router.push("/live-session");
    } catch (e) {
      setMsg(String(e));
    }
  }

  if (!token) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">Dashboard</h1>
        <p className="text-sm text-zinc-600">
          START se Playwright automation chalegi; OTP aane par modal popup open hoga.
        </p>
      </div>

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
            {dealers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <Link href="/settings" className="text-sm text-blue-600 underline">
            GDMS credentials / workflows
          </Link>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Automation</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Button onClick={() => void start("gdms_login")}>START — GDMS login + OTP</Button>
            <Button variant="outline" onClick={() => void start("inquiry_fetch")}>
              Inquiry fetch
            </Button>
            <Button variant="outline" onClick={() => void start("inquiry_transfer")}>
              Inquiry transfer
            </Button>
            <Button variant="outline" onClick={() => void start("status_update")}>
              Status update
            </Button>
            {msg && <p className="text-sm text-amber-800">{msg}</p>}
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
