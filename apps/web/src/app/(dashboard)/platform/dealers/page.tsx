"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { FormField } from "@/components/layout/form-field";
import { SectionBlock } from "@/components/layout/section-block";
import { EmptyState } from "@/components/ui/empty-state";
import { Building2, Pencil, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api";
import { toUserMessage } from "@/lib/user-messages";
import { useAuthStore } from "@/stores/auth-store";

type DealerAdmin = {
  id: string;
  username: string;
  displayName: string | null;
  isActive: boolean;
};

type DealerRow = {
  id: string;
  name: string;
  isActive: boolean;
  maxTeamLeaders: number;
  maxSalesConsultants: number;
  _count?: { users: number };
  users?: DealerAdmin[];
};

export default function PlatformDealersPage() {
  const router = useRouter();
  const token = useAuthStore((s) => s.accessToken);
  const role = useAuthStore((s) => s.user?.role);
  const [rows, setRows] = useState<DealerRow[]>([]);
  const [name, setName] = useState("");
  const [maxTl, setMaxTl] = useState("10");
  const [maxSc, setMaxSc] = useState("50");
  const [adminUsername, setAdminUsername] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminDisplayName, setAdminDisplayName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addingAdminFor, setAddingAdminFor] = useState<string | null>(null);
  const [fixUsername, setFixUsername] = useState("");
  const [fixPassword, setFixPassword] = useState("");
  const [fixDisplayName, setFixDisplayName] = useState("");
  const [fixBusy, setFixBusy] = useState(false);
  const [editDealer, setEditDealer] = useState<DealerRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editMaxTl, setEditMaxTl] = useState("");
  const [editMaxSc, setEditMaxSc] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DealerRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    if (!token) router.replace("/login");
    else if (role && role !== "SUPER_ADMIN") router.replace("/dashboard");
  }, [token, role, router]);

  useEffect(() => {
    if (!token || role !== "SUPER_ADMIN") return;
    void apiFetch<DealerRow[]>("/v1/dealers", { token }).then(setRows).catch((e) => setErr(toUserMessage(e)));
  }, [token, role]);

  const canSubmit =
    name.trim().length > 0 &&
    adminUsername.trim().length >= 2 &&
    adminPassword.trim().length >= 4;

  async function createDealer(): Promise<void> {
    if (!token || !canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      await apiFetch("/v1/dealers", {
        method: "POST",
        token,
        body: JSON.stringify({
          name: name.trim(),
          maxTeamLeaders: Number(maxTl) || 10,
          maxSalesConsultants: Number(maxSc) || 50,
          admin: {
            username: adminUsername.trim(),
            password: adminPassword,
            ...(adminDisplayName.trim()
              ? { displayName: adminDisplayName.trim() }
              : {}),
          },
        }),
      });
      setName("");
      setAdminUsername("");
      setAdminPassword("");
      setAdminDisplayName("");
      const list = await apiFetch<DealerRow[]>("/v1/dealers", { token });
      setRows(list);
    } catch (e) {
      setErr(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function addAdminToDealer(dealerId: string): Promise<void> {
    if (!token || fixUsername.trim().length < 2 || fixPassword.length < 4) return;
    setFixBusy(true);
    setErr(null);
    try {
      await apiFetch("/v1/users", {
        method: "POST",
        token,
        body: JSON.stringify({
          username: fixUsername.trim(),
          password: fixPassword,
          role: "DEALER_ADMIN",
          dealerId,
          ...(fixDisplayName.trim() ? { displayName: fixDisplayName.trim() } : {}),
        }),
      });
      setAddingAdminFor(null);
      setFixUsername("");
      setFixPassword("");
      setFixDisplayName("");
      setRows(await apiFetch<DealerRow[]>("/v1/dealers", { token }));
    } catch (e) {
      setErr(toUserMessage(e));
    } finally {
      setFixBusy(false);
    }
  }

  async function refreshDealers(): Promise<void> {
    if (!token) return;
    setRows(await apiFetch<DealerRow[]>("/v1/dealers", { token }));
  }

  function openEdit(dealer: DealerRow): void {
    setEditDealer(dealer);
    setEditName(dealer.name);
    setEditMaxTl(String(dealer.maxTeamLeaders));
    setEditMaxSc(String(dealer.maxSalesConsultants));
    setErr(null);
  }

  async function saveEdit(): Promise<void> {
    if (!token || !editDealer || !editName.trim()) return;
    setEditSaving(true);
    setErr(null);
    try {
      await apiFetch(`/v1/dealers/${editDealer.id}`, {
        method: "PATCH",
        token,
        body: JSON.stringify({
          name: editName.trim(),
          maxTeamLeaders: Number(editMaxTl) || 0,
          maxSalesConsultants: Number(editMaxSc) || 0,
        }),
      });
      setEditDealer(null);
      await refreshDealers();
    } catch (e) {
      setErr(toUserMessage(e));
    } finally {
      setEditSaving(false);
    }
  }

  async function deleteDealer(): Promise<void> {
    if (!token || !deleteTarget) return;
    setDeleteBusy(true);
    setErr(null);
    try {
      await apiFetch(`/v1/dealers/${deleteTarget.id}`, { method: "DELETE", token });
      setDeleteTarget(null);
      await refreshDealers();
    } catch (e) {
      setErr(toUserMessage(e));
    } finally {
      setDeleteBusy(false);
    }
  }

  async function patchDealer(
    id: string,
    patch: Partial<Pick<DealerRow, "isActive" | "maxTeamLeaders" | "maxSalesConsultants" | "name">>,
  ): Promise<void> {
    if (!token) return;
    setErr(null);
    try {
      await apiFetch(`/v1/dealers/${id}`, { method: "PATCH", token, body: JSON.stringify(patch) });
      await refreshDealers();
    } catch (e) {
      setErr(toUserMessage(e));
    }
  }

  if (role !== "SUPER_ADMIN") return null;

  return (
    <>
      <PageHeader title="Dealers" eyebrow="Platform" />

      {err ? <Alert variant="error">{err}</Alert> : null}

      <div className="content-grid">
        <SectionBlock title="New dealer">
          <Card>
            <CardHeader>
              <CardTitle>Add dealer</CardTitle>
            </CardHeader>
            <CardContent className="grid max-w-lg gap-4">
              <form className="grid gap-4" autoComplete="off" onSubmit={(e) => e.preventDefault()}>
              <FormField label="Dealer name" htmlFor="dealer-name" required>
                <Input
                  id="dealer-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ashiana Automobiles Pvt Ltd"
                />
              </FormField>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Max Team Leaders" htmlFor="max-tl" required>
                  <Input
                    id="max-tl"
                    type="number"
                    min={0}
                    value={maxTl}
                    onChange={(e) => setMaxTl(e.target.value)}
                  />
                </FormField>
                <FormField label="Max Sales Consultants" htmlFor="max-sc" required>
                  <Input
                    id="max-sc"
                    type="number"
                    min={0}
                    value={maxSc}
                    onChange={(e) => setMaxSc(e.target.value)}
                  />
                </FormField>
              </div>

              <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
                <p className="text-sm font-medium text-foreground">Dealer Admin (first login)</p>
              </div>

              <FormField label="Admin username" htmlFor="admin-user" required>
                <Input
                  id="admin-user"
                  suppressAutofill
                  autofillFieldKey="dealer-admin-username"
                  value={adminUsername}
                  onChange={(e) => setAdminUsername(e.target.value)}
                  placeholder="dealer2_admin"
                />
              </FormField>
              <FormField label="Admin password" htmlFor="admin-pass" required>
                <Input
                  id="admin-pass"
                  type="password"
                  suppressAutofill
                  autofillFieldKey="dealer-admin-password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                />
              </FormField>
              <FormField label="Display name" htmlFor="admin-name">
                <Input
                  id="admin-name"
                  value={adminDisplayName}
                  onChange={(e) => setAdminDisplayName(e.target.value)}
                  placeholder="Rajesh Kumar"
                />
              </FormField>

              <Button disabled={busy || !canSubmit} onClick={() => void createDealer()}>
                Create dealer & admin
              </Button>
              </form>
            </CardContent>
          </Card>
        </SectionBlock>

        <Card>
          <CardHeader>
            <CardTitle>All dealers</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {rows.map((d) => {
              const admins = d.users ?? [];
              return (
                <div
                  key={d.id}
                  className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0 space-y-2">
                    <p className="font-medium">{d.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Users: {d._count?.users ?? 0} · TL cap: {d.maxTeamLeaders} · SC cap:{" "}
                      {d.maxSalesConsultants}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium text-muted-foreground">Admin:</span>
                      {admins.length === 0 ? (
                        <Badge variant="warning">None</Badge>
                      ) : (
                        admins.map((a) => (
                          <Badge key={a.id} variant={a.isActive ? "success" : "secondary"}>
                            {a.displayName?.trim() || a.username}
                            {!a.isActive ? " (disabled)" : null}
                          </Badge>
                        ))
                      )}
                    </div>
                    {admins.length === 0 ? (
                      addingAdminFor === d.id ? (
                        <div className="mt-2 grid max-w-sm gap-2 rounded-lg border border-dashed border-border bg-muted/20 p-3">
                          <Input
                            placeholder="Admin username"
                            suppressAutofill
                            autofillFieldKey="dealer-fix-admin-username"
                            value={fixUsername}
                            onChange={(e) => setFixUsername(e.target.value)}
                          />
                          <Input
                            type="password"
                            placeholder="Password (min 4)"
                            suppressAutofill
                            autofillFieldKey="dealer-fix-admin-password"
                            value={fixPassword}
                            onChange={(e) => setFixPassword(e.target.value)}
                          />
                          <Input
                            placeholder="Display name (optional)"
                            value={fixDisplayName}
                            onChange={(e) => setFixDisplayName(e.target.value)}
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              disabled={fixBusy || fixUsername.trim().length < 2 || fixPassword.length < 4}
                              onClick={() => void addAdminToDealer(d.id)}
                            >
                              {fixBusy ? "Saving…" : "Save admin"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setAddingAdminFor(null);
                                setFixUsername("");
                                setFixPassword("");
                                setFixDisplayName("");
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-2"
                          onClick={() => {
                            setAddingAdminFor(d.id);
                            setFixUsername("");
                            setFixPassword("");
                            setFixDisplayName("");
                          }}
                        >
                          Add dealer admin
                        </Button>
                      )
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => openEdit(d)}>
                      <Pencil className="mr-1.5 h-3.5 w-3.5" />
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => {
                        setDeleteTarget(d);
                        setErr(null);
                      }}
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      Delete
                    </Button>
                    <Button
                      size="sm"
                      variant={d.isActive ? "outline" : "default"}
                      onClick={() => void patchDealer(d.id, { isActive: !d.isActive })}
                    >
                      {d.isActive ? "Disable" : "Enable"}
                    </Button>
                  </div>
                </div>
              );
            })}
            {rows.length === 0 ? (
              <EmptyState icon={Building2} title="No dealers yet" />
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Dialog open={editDealer != null} onOpenChange={(open) => !open && setEditDealer(null)}>
        <DialogContent>
          <DialogTitle>Edit dealer</DialogTitle>
          <div className="mt-4 grid gap-4">
            <FormField label="Dealer name" htmlFor="edit-dealer-name" required>
              <Input
                id="edit-dealer-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Max Team Leaders" htmlFor="edit-max-tl" required>
                <Input
                  id="edit-max-tl"
                  type="number"
                  min={0}
                  value={editMaxTl}
                  onChange={(e) => setEditMaxTl(e.target.value)}
                />
              </FormField>
              <FormField label="Max Sales Consultants" htmlFor="edit-max-sc" required>
                <Input
                  id="edit-max-sc"
                  type="number"
                  min={0}
                  value={editMaxSc}
                  onChange={(e) => setEditMaxSc(e.target.value)}
                />
              </FormField>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditDealer(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={editSaving || !editName.trim()}
              onClick={() => void saveEdit()}
            >
              {editSaving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget != null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogTitle>Delete dealer</DialogTitle>
          <p className="mt-3 text-sm text-foreground">
            Delete <strong>{deleteTarget?.name}</strong>? All users, leads, and runs for this dealer
            will be removed.
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteBusy}
              onClick={() => void deleteDealer()}
            >
              {deleteBusy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
