"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";
import { usePersistReady } from "@/hooks/use-persist-ready";

export default function LoginPage() {
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);
  const token = useAuthStore((s) => s.accessToken);
  const storageReady = usePersistReady();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!storageReady || !token) return;
    router.replace("/dashboard");
  }, [storageReady, token, router]);

  async function onContinue(): Promise<void> {
    setErr(null);
    setBusy(true);
    try {
      const res = await apiFetch<{
        accessToken: string;
        user: { id: string; email: string; role: string; dealerId: string | null };
      }>("/v1/auth/login", { method: "POST", body: JSON.stringify({}) });
      setAuth(res.accessToken, res.user);
      router.replace("/dashboard");
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      try {
        const j = JSON.parse(raw) as { error?: string };
        if (typeof j?.error === "string") setErr(j.error);
        else setErr(raw);
      } catch {
        setErr(raw);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-100 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>GDMS SaaS Login</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-zinc-600">
            Dev / non-production API: sirf Login dabao — pehla user auto-banta hai agar DB khali ho. Agar API{" "}
            <code className="rounded bg-zinc-200 px-1">NODE_ENV=production</code> hai to{" "}
            <code className="rounded bg-zinc-200 px-1">AUTH_DEV_OPEN_LOGIN=true</code> chahiye, aur{" "}
            <code className="rounded bg-zinc-200 px-1">CORS_ORIGIN</code> mein tumhara web URL.
          </p>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <Button
            type="button"
            className="w-full"
            disabled={busy || !storageReady}
            onClick={() => void onContinue()}
          >
            {!storageReady ? "…" : busy ? "…" : "Login"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
