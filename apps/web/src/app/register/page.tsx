"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { AuthLayout } from "@/components/auth/auth-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchSetupStatus } from "@/lib/auth-session";
import { homePathForRole } from "@/lib/roles";
import { apiFetch } from "@/lib/api";
import { toUserMessage } from "@/lib/user-messages";
import { useAuthStore } from "@/stores/auth-store";
import { usePersistReady } from "@/hooks/use-persist-ready";

export default function RegisterPage() {
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);
  const token = useAuthStore((s) => s.accessToken);
  const storageReady = usePersistReady();
  const [username, setUsername] = useState("super");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState<boolean | null>(null);

  useEffect(() => {
    void fetchSetupStatus().then((s) => setRegistrationOpen(s.registrationOpen));
  }, []);

  useEffect(() => {
    if (!storageReady || !token) return;
    router.replace(homePathForRole(useAuthStore.getState().user?.role));
  }, [storageReady, token, router]);

  useEffect(() => {
    if (registrationOpen === false) router.replace("/login");
  }, [registrationOpen, router]);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    const userTrim = username.trim();
    if (!userTrim) {
      setErr("Please enter a username.");
      return;
    }
    if (password.length < 8) {
      setErr("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setErr("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch<{
        accessToken: string;
        user: { id: string; username: string; email: string; role: string; dealerId: string | null };
      }>("/v1/auth/register", {
        method: "POST",
        body: JSON.stringify({ username: userTrim, password }),
      });
      setAuth(res.accessToken, res.user);
      router.replace(homePathForRole(res.user.role));
    } catch (error) {
      setErr(toUserMessage(error, "auth"));
    } finally {
      setBusy(false);
    }
  }

  if (registrationOpen === null) {
    return (
      <AuthLayout title="Setup">
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AuthLayout>
    );
  }

  const signingUp = busy || !storageReady;
  const canSubmit =
    username.trim().length >= 2 && password.length >= 8 && confirm.length >= 8 && password === confirm;

  return (
    <AuthLayout title="Create platform admin">
      <Card className="border-border/80 shadow-elevated">
        <CardContent>
          <form onSubmit={(e) => void onSubmit(e)} className="form-stack">
            <div className="form-field">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                autoComplete="username"
                placeholder="super"
                value={username}
                onChange={(ev) => setUsername(ev.target.value)}
                disabled={signingUp}
                required
              />
            </div>
            <div className="form-field">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={password}
                  onChange={(ev) => setPassword(ev.target.value)}
                  disabled={signingUp}
                  required
                  minLength={8}
                  className="pr-11"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="form-field">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input
                id="confirm"
                type="password"
                value={confirm}
                onChange={(ev) => setConfirm(ev.target.value)}
                disabled={signingUp}
                required
              />
            </div>
            {err ? (
              <p className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">{err}</p>
            ) : null}
            <Button type="submit" className="mt-1 w-full" size="lg" disabled={signingUp || !canSubmit}>
              {signingUp ? "Creating…" : "Create account"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <p className="mt-8 text-center text-sm text-muted-foreground">
        <Link href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
