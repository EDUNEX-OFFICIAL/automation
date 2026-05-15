"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";
import { useLeadsStore } from "@/stores/leads-store";
import type { InquiryRow } from "@/stores/leads-store";

type DealerLite = { id: string; name: string };

export default function LeadsPage() {
  const router = useRouter();
  const token = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const rows = useLeadsStore((s) => s.rows);
  const setRows = useLeadsStore((s) => s.setRows);
  const setInquiriesQuerySuffix = useLeadsStore((s) => s.setInquiriesQuerySuffix);
  const callPhaseByInquiryId = useLeadsStore((s) => s.callPhaseByInquiryId);

  const [dealers, setDealers] = useState<DealerLite[]>([]);
  const [superDealerFilter, setSuperDealerFilter] = useState<string>("all");

  useEffect(() => {
    if (!token) router.replace("/login");
  }, [token, router]);

  useEffect(() => {
    if (!token || user?.role !== "SUPER_ADMIN") return;
    void apiFetch<DealerLite[]>("/v1/dealers", { token }).then(setDealers);
  }, [token, user?.role]);

  useEffect(() => {
    if (!token || !user) return;
    let q = "";
    if (user.role === "SUPER_ADMIN") {
      q = superDealerFilter === "all" ? "" : `?dealerId=${superDealerFilter}`;
    } else {
      if (!user.dealerId) {
        setInquiriesQuerySuffix("");
        return;
      }
      q = `?dealerId=${user.dealerId}`;
    }
    setInquiriesQuerySuffix(q);
    void apiFetch<InquiryRow[]>(`/v1/inquiries${q}`, { token }).then(setRows);
  }, [token, user, superDealerFilter, setRows, setInquiriesQuerySuffix]);

  async function callLead(id: string): Promise<void> {
    if (!token) return;
    await apiFetch(`/v1/inquiries/${id}/call`, { method: "POST", token, body: JSON.stringify({}) });
  }

  async function saveNotes(id: string, notes: string): Promise<void> {
    if (!token) return;
    const row = await apiFetch<InquiryRow>(`/v1/inquiries/${id}`, {
      method: "PATCH",
      token,
      body: JSON.stringify({ followUpNotes: notes }),
    });
    setRows(rows.map((r) => (r.id === id ? row : r)));
  }

  if (!token) return null;

  const showDealerCol = user?.role === "SUPER_ADMIN";

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Leads</h1>
      {user?.role === "SUPER_ADMIN" ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-zinc-600">Dealer</span>
          <select
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-zinc-900"
            value={superDealerFilter}
            onChange={(e) => setSuperDealerFilter(e.target.value)}
          >
            <option value="all">All dealers</option>
            {dealers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Manual follow-up</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200">
                  {showDealerCol ? <th className="p-2">Dealer</th> : null}
                  <th className="p-2">Phone</th>
                  <th className="p-2">Name</th>
                  <th className="p-2">Category</th>
                  <th className="p-2">Notes</th>
                  <th className="p-2">Call / SIM</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-zinc-100">
                    {showDealerCol ? (
                      <td className="p-2 text-zinc-600">{r.dealerName ?? "—"}</td>
                    ) : null}
                    <td className="p-2">{r.phone}</td>
                    <td className="p-2">{r.name}</td>
                    <td className="p-2">{r.category}</td>
                    <td className="p-2">
                      <NotesCell
                        initial={r.followUpNotes ?? ""}
                        onSave={(n) => void saveNotes(r.id, n)}
                      />
                    </td>
                    <td className="p-2">
                      <div className="flex flex-col gap-1">
                        <Button size="sm" variant="outline" onClick={() => void callLead(r.id)}>
                          Click-to-call
                        </Button>
                        {callPhaseByInquiryId[r.id] ? (
                          <span className="text-xs text-zinc-500">
                            {callPhaseByInquiryId[r.id]}
                          </span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function NotesCell({ initial, onSave }: { initial: string; onSave: (n: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <div className="flex gap-1">
      <Input value={v} onChange={(e) => setV(e.target.value)} className="h-8" />
      <Button size="sm" type="button" variant="ghost" onClick={() => onSave(v)}>
        Save
      </Button>
    </div>
  );
}
