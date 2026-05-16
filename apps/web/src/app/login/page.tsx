"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api";
import { toUserMessage } from "@/lib/user-messages";
import { useAuthStore } from "@/stores/auth-store";
import { usePersistReady } from "@/hooks/use-persist-ready";

export default function LoginPage() {
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);
  const token = useAuthStore((s) => s.accessToken);
  const storageReady = usePersistReady();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!storageReady || !token) return;
    router.replace("/dashboard");
  }, [storageReady, token, router]);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const emailTrim = email.trim();
      const body =
        emailTrim || password
          ? JSON.stringify({ email: emailTrim, password })
          : JSON.stringify({});
      const res = await apiFetch<{
        accessToken: string;
        user: { id: string; email: string; role: string; dealerId: string | null };
      }>("/v1/auth/login", { method: "POST", body });
      setAuth(res.accessToken, res.user);
      router.replace("/dashboard");
    } catch (error) {
      setErr(toUserMessage(error, "auth"));
    } finally {
      setBusy(false);
    }
  }

  const signingIn = busy || !storageReady;

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 py-12">
      <Card className="w-full max-w-md border-zinc-200 shadow-sm">
        <CardHeader className="space-y-1 text-center">
          <CardTitle className="text-2xl font-semibold tracking-tight">GDMS Automation</CardTitle>
          <p className="text-sm text-zinc-500">Sign in to your dealer workspace</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@dealer.com"
                value={email}
                onChange={(ev) => setEmail(ev.target.value)}
                disabled={signingIn}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(ev) => setPassword(ev.target.value)}
                disabled={signingIn}
              />
            </div>
            {err && (
              <p className="text-sm text-red-600" role="alert">
                {err}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={signingIn}>
              {!storageReady ? "Loading…" : busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
          <p className="mt-6 text-center text-sm text-zinc-500">
            Need access? Contact your administrator.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

