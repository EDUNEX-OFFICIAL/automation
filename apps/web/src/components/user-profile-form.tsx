"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBanner } from "@/components/ui/status-banner";
import { apiFetch, getApiUrl } from "@/lib/api";
import { resolveAvatarSrc } from "@/lib/avatar";
import { ROLE_LABELS, type AppRole } from "@/lib/roles";
import { toUserMessage } from "@/lib/user-messages";

export type UserProfileDto = {
  id: string;
  username: string;
  displayName: string | null;
  displayLabel: string;
  avatarUrl: string | null;
  email: string;
  role: string;
  dealerId: string | null;
  reportsToUserId: string | null;
  teamType?: string | null;
  isActive: boolean;
  reportsTo?: { id: string; username: string; displayName: string | null } | null;
};

type Props = {
  token: string;
  userId: string;
  isSelf: boolean;
  onSaved?: () => void;
};

export function UserProfileForm({ token, userId, isSelf, onSaved }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [profile, setProfile] = useState<UserProfileDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void apiFetch<UserProfileDto>(`/v1/users/${userId}/profile`, { token })
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setDisplayName(p.displayName ?? "");
        setUsername(p.username);
        setAvatarUrl(p.avatarUrl?.startsWith("http") ? p.avatarUrl : "");
      })
      .catch((e) => {
        if (!cancelled) setErr(toUserMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, token]);

  if (loading && !profile) {
    return <p className="text-sm text-muted-foreground">Loading profile…</p>;
  }

  if (!profile) {
    return err ? <p className="text-sm text-destructive">{err}</p> : null;
  }

  const avatarSrc = resolveAvatarSrc(profile.avatarUrl);
  const current = profile;

  async function save(): Promise<void> {
    setBusy(true);
    setOk(false);
    setErr(null);
    try {
      const body: Record<string, unknown> = {};
      if (displayName !== (current.displayName ?? "")) {
        body.displayName = displayName;
      }
      if (username !== current.username) body.username = username;
      if (password.trim()) body.password = password;
      if (avatarUrl.trim()) body.avatarUrl = avatarUrl.trim();
      else if (!current.avatarUrl?.startsWith("/uploads/")) body.clearAvatar = !avatarUrl.trim();

      const updated = await apiFetch<UserProfileDto>(`/v1/users/${userId}/profile`, {
        method: "PATCH",
        token,
        body: JSON.stringify(body),
      });
      setProfile(updated);
      setPassword("");
      setOk(true);
      onSaved?.();
    } catch (e) {
      setErr(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function uploadAvatar(file: File): Promise<void> {
    setUploading(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${getApiUrl()}/v1/users/${userId}/avatar`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Upload failed (${res.status})`);
      }
      const updated = (await res.json()) as UserProfileDto;
      setProfile(updated);
      setOk(true);
      onSaved?.();
    } catch (e) {
      setErr(toUserMessage(e));
    } finally {
      setUploading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{isSelf ? "Your profile" : `Profile — ${profile.displayLabel}`}</CardTitle>
        <CardDescription>
          User ID: <span className="font-mono text-xs">{profile.id}</span> ·{" "}
          {ROLE_LABELS[profile.role as AppRole] ?? profile.role}
          {profile.reportsTo
            ? ` · reports to ${profile.reportsTo.displayName ?? profile.reportsTo.username}`
            : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="form-stack max-w-lg">
        <div className="flex items-center gap-4">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted text-2xl font-bold text-primary">
            {avatarSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatarSrc} alt="" className="h-full w-full object-cover" />
            ) : (
              profile.username.slice(0, 2).toUpperCase()
            )}
          </div>
          <div className="space-y-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadAvatar(f);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? "Uploading…" : "Upload photo"}
            </Button>
          </div>
        </div>

        <div>
          <Label>Display name</Label>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={profile.username} />
        </div>
        <div>
          <Label>Username (login ID)</Label>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </div>
        <div>
          <Label>{isSelf ? "New password" : "Reset password"}</Label>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={isSelf ? "Leave blank to keep current" : "Leave blank to keep unchanged"}
            autoComplete="new-password"
          />
        </div>
        <div>
          <Label>Avatar URL (optional)</Label>
          <Input
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            placeholder="https://… or upload a photo above"
          />
        </div>

        {ok ? <StatusBanner variant="success" title="Profile saved" /> : null}
        {err ? (
          <StatusBanner variant="error" title="Could not save">
            {err}
          </StatusBanner>
        ) : null}

        <Button disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save profile"}
        </Button>
      </CardContent>
    </Card>
  );
}
