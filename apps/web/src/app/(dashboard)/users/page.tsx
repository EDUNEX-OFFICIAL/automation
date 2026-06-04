"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { NativeSelect } from "@/components/ui/native-select";
import { apiFetch, getApiUrl } from "@/lib/api";
import { resolveAvatarSrc } from "@/lib/avatar";
import { Users } from "lucide-react";
import { toUserMessage } from "@/lib/user-messages";
import { ROLE_LABELS, TEAM_TYPE_LABELS, type AppRole, type TeamType } from "@/lib/roles";
import { useAuthStore } from "@/stores/auth-store";

type Row = {
  id: string;
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  role: string;
  dealerId: string | null;
  reportsToUserId: string | null;
  teamType: TeamType | null;
  isActive: boolean;
  reportsTo?: { id: string; username: string; teamType?: TeamType | null } | null;
};

export default function UsersPage() {
  const router = useRouter();
  const token = useAuthStore((s) => s.accessToken);
  const role = useAuthStore((s) => s.user?.role);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const syncUserFromApi = useAuthStore((s) => s.syncUserFromApi);
  const [rows, setRows] = useState<Row[]>([]);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [newRole, setNewRole] = useState<"TEAM_LEADER" | "SALES_CONSULTANT">("TEAM_LEADER");
  const [teamType, setTeamType] = useState<TeamType>("DIGITAL");
  const [reportsToUserId, setReportsToUserId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isAdmin = role === "DEALER_ADMIN" || role === "SUPER_ADMIN";
  const isTl = role === "TEAM_LEADER";

  const teamLeaders = useMemo(
    () => rows.filter((r) => r.role === "TEAM_LEADER" && r.isActive),
    [rows],
  );

  useEffect(() => {
    if (!token) router.replace("/login");
    else if (role && !isAdmin && !isTl) router.replace("/dashboard");
  }, [token, role, router, isAdmin, isTl]);

  useEffect(() => {
    if (!token || (!isAdmin && !isTl)) return;
    void apiFetch<Row[]>("/v1/users", { token })
      .then(setRows)
      .catch((e) => setErr(toUserMessage(e)));
    void apiFetch<{
      id: string;
      username: string;
      email: string;
      role: string;
      dealerId: string | null;
      canRunEnquiryTransfer?: boolean;
      effectiveTeamType?: TeamType | null;
      teamType?: TeamType | null;
    }>("/v1/me", { token })
      .then((me) => {
        const cur = useAuthStore.getState().user;
        if (cur) syncUserFromApi({ ...cur, ...me });
      })
      .catch(() => undefined);
  }, [token, isAdmin, isTl, syncUserFromApi]);

  async function refresh(): Promise<void> {
    if (!token) return;
    setRows(await apiFetch<Row[]>("/v1/users", { token }));
  }

  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  async function uploadAvatar(userId: string, file: File): Promise<void> {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${getApiUrl()}/v1/users/${userId}/avatar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? `Photo upload failed (${res.status})`);
    }
  }

  function clearPhoto(): void {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoFile(null);
    setPhotoPreview(null);
    if (photoInputRef.current) photoInputRef.current.value = "";
  }

  function onPhotoSelected(file: File | undefined): void {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setErr("Only image files are allowed.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setErr("Photo must be 2 MB or smaller.");
      return;
    }
    setErr(null);
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  }

  async function create(): Promise<void> {
    if (!token) return;
    setErr(null);

    if (isAdmin && newRole === "SALES_CONSULTANT" && !reportsToUserId) {
      setErr("Select which Team Leader this Sales Consultant reports to.");
      return;
    }

    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        username: username.trim(),
        password,
        role: isTl ? "SALES_CONSULTANT" : newRole,
      };
      if (displayName.trim()) {
        payload.displayName = displayName.trim();
      }
      if (isAdmin && newRole === "TEAM_LEADER") {
        payload.teamType = teamType;
      }
      if (isAdmin && newRole === "SALES_CONSULTANT") {
        payload.reportsToUserId = reportsToUserId;
      }

      const created = await apiFetch<{ id: string }>("/v1/users", {
        method: "POST",
        token,
        body: JSON.stringify(payload),
      });
      if (photoFile) {
        await uploadAvatar(created.id, photoFile);
      }
      setUsername("");
      setDisplayName("");
      setPassword("");
      clearPhoto();
      setReportsToUserId("");
      await refresh();
    } catch (e) {
      setErr(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(id: string, isActive: boolean): Promise<void> {
    if (!token) return;
    setErr(null);
    try {
      await apiFetch(`/v1/users/${id}`, {
        method: "PATCH",
        token,
        body: JSON.stringify({ isActive: !isActive }),
      });
      await refresh();
    } catch (e) {
      setErr(toUserMessage(e));
    }
  }

  function canManageRow(u: Row): boolean {
    return (
      ((isAdmin || isTl) && u.role === "SALES_CONSULTANT") ||
      (isAdmin && u.role === "TEAM_LEADER")
    );
  }

  async function deleteUser(u: Row): Promise<void> {
    if (!token || u.id === currentUserId) return;
    const label = u.displayName?.trim() || u.username;
    if (
      !window.confirm(
        `Delete ${label} permanently? Their GDMS credentials and notifications will be removed. This cannot be undone.`,
      )
    ) {
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await apiFetch(`/v1/users/${u.id}`, { method: "DELETE", token });
      await refresh();
    } catch (e) {
      setErr(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!isAdmin && !isTl) {
    return <p className="text-sm text-muted-foreground">Team management is not available for your role.</p>;
  }

  const roster = isTl
    ? rows.filter((u) => u.role === "SALES_CONSULTANT")
    : rows.filter((u) => u.role !== "SUPER_ADMIN" && u.role !== "DEALER_ADMIN");

  return (
    <>
      <PageHeader title={isTl ? "My team" : "Team"} eyebrow="People" />

      {err ? <Alert variant="error">{err}</Alert> : null}

      <div className="content-grid">
      <Card>
        <CardHeader>
          <CardTitle>{isTl ? "Add Sales Consultant" : "Add team member"}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="form-stack"
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
          <div>
            <Label htmlFor="team-member-username">Username</Label>
            <Input
              id="team-member-username"
              suppressAutofill
              autofillFieldKey="team-member-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={isTl ? "e.g. 1sc3" : "e.g. 1tl3 or 1sc3"}
            />
          </div>
          <div>
            <Label htmlFor="team-member-display-name">Display name</Label>
            <Input
              id="team-member-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Full name"
            />
          </div>
          <div>
            <Label>Photo</Label>
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted text-lg font-bold text-primary">
                {photoPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photoPreview} alt="" className="h-full w-full object-cover" />
                ) : (
                  (displayName.trim() || username.trim()).slice(0, 2).toUpperCase() || "?"
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => onPhotoSelected(e.target.files?.[0])}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => photoInputRef.current?.click()}
                >
                  {photoFile ? "Change photo" : "Upload photo"}
                </Button>
                {photoFile ? (
                  <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={clearPhoto}>
                    Remove
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
          <div>
            <Label htmlFor="team-member-password">Password</Label>
            <Input
              id="team-member-password"
              type="password"
              suppressAutofill
              autofillFieldKey="team-member-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {isAdmin ? (
            <div>
              <Label>Role</Label>
              <NativeSelect
                value={newRole}
                onChange={(e) => {
                  const v = e.target.value as "TEAM_LEADER" | "SALES_CONSULTANT";
                  setNewRole(v);
                  if (v === "TEAM_LEADER") setReportsToUserId("");
                }}
              >
                <option value="TEAM_LEADER">Team Leader</option>
                <option value="SALES_CONSULTANT">Sales Consultant</option>
              </NativeSelect>
            </div>
          ) : null}

          {isAdmin && newRole === "TEAM_LEADER" ? (
            <div>
              <Label>Team type</Label>
              <NativeSelect
                value={teamType}
                onChange={(e) => setTeamType(e.target.value as TeamType)}
              >
                <option value="DIGITAL">{TEAM_TYPE_LABELS.DIGITAL}</option>
                <option value="FIELD">{TEAM_TYPE_LABELS.FIELD}</option>
              </NativeSelect>
            </div>
          ) : null}

          {isAdmin && newRole === "SALES_CONSULTANT" ? (
            <div>
              <Label>Reports to (Team Leader) *</Label>
              <NativeSelect
                value={reportsToUserId}
                onChange={(e) => setReportsToUserId(e.target.value)}
                required
              >
                <option value="">Select TL…</option>
                {teamLeaders.map((tl) => (
                  <option key={tl.id} value={tl.id}>
                    {tl.username}
                    {tl.teamType ? ` (${TEAM_TYPE_LABELS[tl.teamType]})` : ""}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}

          <Button type="submit" disabled={busy || !username.trim() || !password}>
            {busy ? "Creating…" : "Create user"}
          </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{isTl ? "Your Sales Consultants" : "Team roster"}</CardTitle>
        </CardHeader>
        <CardContent>
          {roster.length === 0 ? (
            <EmptyState icon={Users} title="No team members yet" />
          ) : (
          <ul className="space-y-3 text-sm">
              {roster.map((u) => {
                const avatarSrc = resolveAvatarSrc(u.avatarUrl ?? null);
                return (
                <li key={u.id} className="roster-item">
                  <span className="flex items-center gap-2">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted text-xs font-semibold text-primary">
                      {avatarSrc ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={avatarSrc} alt="" className="h-full w-full object-cover" />
                      ) : (
                        (u.displayName?.trim() || u.username).slice(0, 2).toUpperCase()
                      )}
                    </span>
                    <span>
                    <strong>{u.displayName?.trim() || u.username}</strong>
                    {u.displayName?.trim() ? (
                      <span className="text-muted-foreground"> (@{u.username})</span>
                    ) : null}{" "}
                    — {ROLE_LABELS[u.role as AppRole] ?? u.role}
                    {u.role === "TEAM_LEADER" && u.teamType
                      ? ` · ${TEAM_TYPE_LABELS[u.teamType]}`
                      : ""}
                    {u.reportsTo ? ` → TL ${u.reportsTo.username}` : ""}
                    {!u.isActive ? " (disabled)" : ""}
                    </span>
                  </span>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" asChild>
                      <Link href={`/profile?userId=${encodeURIComponent(u.id)}`}>Edit profile</Link>
                    </Button>
                    {canManageRow(u) ? (
                      <Button size="sm" variant="outline" onClick={() => void toggleActive(u.id, u.isActive)}>
                        {u.isActive ? "Disable" : "Enable"}
                      </Button>
                    ) : null}
                    {canManageRow(u) && u.id !== currentUserId ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-red-300 text-red-900 hover:bg-red-50 dark:border-red-700 dark:text-red-200 dark:hover:bg-red-950/40"
                        disabled={busy}
                        onClick={() => void deleteUser(u)}
                      >
                        Delete
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
              })}
          </ul>
          )}
        </CardContent>
      </Card>
      </div>
    </>
  );
}
