"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Eye, EyeOff, Loader2, MonitorPlay, UsersRound } from "lucide-react";
import { AuthLayout, type AuthHighlight } from "@/components/auth/auth-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchSetupStatus } from "@/lib/auth-session";
import { homePathForRole } from "@/lib/roles";
import { apiFetch } from "@/lib/api";
import { toUserMessage } from "@/lib/user-messages";
import { clearLiveStoreOnly } from "@/lib/terminate-live-session";
import { useAuthStore } from "@/stores/auth-store";
import { usePersistReady } from "@/hooks/use-persist-ready";

const LOGIN_HIGHLIGHTS: AuthHighlight[] = [
  {
    title: "Live GDMS automation",
    description: "Enquiry transfer & Follow up skip — real-time browser monitoring, OTP resume.",
    icon: MonitorPlay,
  },
  {
    title: "Team & leads",
    description: "Role-based teams, per-user GDMS login, and synced lead pipeline.",
    icon: UsersRound,
  },
];

export default function LoginPage() {
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);
  const token = useAuthStore((s) => s.accessToken);
  const storageReady = usePersistReady();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState(false);

  useEffect(() => {
    void fetchSetupStatus().then((s) => setRegistrationOpen(s.registrationOpen));
  }, []);

  useEffect(() => {
    if (!storageReady || !token) return;
    const role = useAuthStore.getState().user?.role;
    router.replace(homePathForRole(role));
  }, [storageReady, token, router]);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    const userTrim = username.trim();
    if (!userTrim || !password) {
      setErr("Please enter your username and password.");
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch<{
        accessToken: string;
        user: {
          id: string;
          username: string;
          email: string;
          role: string;
          dealerId: string | null;
          displayName?: string | null;
          displayLabel?: string;
          avatarUrl?: string | null;
        };
      }>("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: userTrim, password }),
      });
      clearLiveStoreOnly();
      setAuth(res.accessToken, res.user);
      router.replace(homePathForRole(res.user.role));
    } catch (error) {
      setErr(toUserMessage(error, "auth"));
    } finally {
      setBusy(false);
    }
  }

  const signingIn = busy || !storageReady;
  const canSubmit = username.trim().length > 0 && password.length > 0;

  return (
    <AuthLayout title="Welcome back" highlights={LOGIN_HIGHLIGHTS}>
      <Card className="border-border/60 shadow-md dark:shadow-elevated-dark">
        <CardContent>
          <form onSubmit={(e) => void onSubmit(e)} className="form-stack">
            <div className="form-field">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                name="username"
                autoComplete="username"
                placeholder="e.g. 1tl1"
                value={username}
                onChange={(ev) => setUsername(ev.target.value)}
                disabled={signingIn}
                required
              />
            </div>
            <div className="form-field">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(ev) => setPassword(ev.target.value)}
                  disabled={signingIn}
                  required
                  className="pr-11"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            {err ? (
              <p className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">
                {err}
              </p>
            ) : null}
            <Button type="submit" className="mt-1 w-full" size="lg" disabled={signingIn || !canSubmit}>
              {signingIn ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {!storageReady ? "Loading…" : "Signing in…"}
                </>
              ) : (
                "Sign in"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      <p className="mt-8 text-center text-sm text-muted-foreground">
        {registrationOpen ? (
          <>
            First-time setup?{" "}
            <Link href="/register" className="font-medium text-primary hover:underline">
              Create platform admin
            </Link>
          </>
        ) : (
          "Need access? Contact your administrator."
        )}
      </p>
    </AuthLayout>
  );
}
