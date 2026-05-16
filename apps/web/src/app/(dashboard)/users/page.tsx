"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";

type Row = { id: string; email: string; role: string; dealerId: string | null };

export default function UsersPage() {
  const router = useRouter();
  const token = useAuthStore((s) => s.accessToken);
  const role = useAuthStore((s) => s.user?.role);
  const [rows, setRows] = useState<Row[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newRole, setNewRole] = useState<"USER" | "DEALER">("USER");
  const [dealerId, setDealerId] = useState<string | undefined>();

  useEffect(() => {
    if (!token) router.replace("/login");
  }, [token, router]);

  useEffect(() => {
    if (!token) return;
    void apiFetch<Row[]>("/v1/users", { token }).then(setRows);
  }, [token]);

  async function create(): Promise<void> {
    if (!token) return;
    await apiFetch("/v1/users", {
      method: "POST",
      token,
      body: JSON.stringify({
        email,
        password,
        role: newRole,
        dealerId,
      }),
    });
    setEmail("");
    setPassword("");
    void apiFetch<Row[]>("/v1/users", { token }).then(setRows);
  }

  if (!token) return null;
  if (role !== "SUPER_ADMIN" && role !== "DEALER") {
    return <p className="text-sm text-zinc-600">The Users page is for admins and dealers only.</p>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Users</h1>
      <Card>
        <CardHeader>
          <CardTitle>Create user</CardTitle>
        </CardHeader>
        <CardContent className="max-w-md space-y-2">
          <div>
            <Label>Email</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label>Password</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {role === "SUPER_ADMIN" && (
            <div>
              <Label>Role</Label>
              <select
                className="w-full rounded border border-zinc-200 px-2 py-2 text-sm"
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as "USER" | "DEALER")}
              >
                <option value="USER">USER</option>
                <option value="DEALER">DEALER</option>
              </select>
            </div>
          )}
          {role === "SUPER_ADMIN" && (
            <div>
              <Label>Dealer ID (for USER/DEALER roles)</Label>
              <Input value={dealerId ?? ""} onChange={(e) => setDealerId(e.target.value || undefined)} />
            </div>
          )}
          <Button onClick={() => void create()}>Create</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All users</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm">
            {rows.map((u) => (
              <li key={u.id}>
                {u.email} — {u.role} — {u.dealerId ?? "—"}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
