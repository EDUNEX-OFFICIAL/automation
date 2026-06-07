"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/layout/form-field";
import { NativeSelect } from "@/components/ui/native-select";
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
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

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
        setLoading(false);
        return;
      }
      q = `?dealerId=${user.dealerId}`;
    }
    const params = new URLSearchParams(q.replace(/^\?/, ""));
    if (search.trim()) params.set("q", search.trim());
    if (cursor) params.set("cursor", cursor);
    const qs = params.toString();
    setInquiriesQuerySuffix(qs ? `?${qs}` : "");
    setLoading(true);
    void apiFetch<{ items: InquiryRow[]; nextCursor: string | null } | InquiryRow[]>(
      `/v1/inquiries${qs ? `?${qs}` : ""}`,
      { token },
    )
      .then((data) => {
        if (Array.isArray(data)) {
          setRows(data);
          setNextCursor(null);
        } else {
          const prev = useLeadsStore.getState().rows;
          setRows(cursor ? [...prev, ...data.items] : data.items);
          setNextCursor(data.nextCursor);
        }
      })
      .finally(() => setLoading(false));
  }, [token, user, superDealerFilter, search, cursor, setRows, setInquiriesQuerySuffix]);

  useEffect(() => {
    setCursor(null);
  }, [superDealerFilter, search]);

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
    <>
      <PageHeader title="Leads" eyebrow="Pipeline" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <FormField label="Search" htmlFor="leads-search" className="flex-1">
          <Input
            id="leads-search"
            placeholder="Phone or name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </FormField>
      </div>
      {user?.role === "SUPER_ADMIN" ? (
        <Card>
          <CardContent className="py-4">
            <FormField label="Dealer filter" htmlFor="leads-dealer-filter">
              <NativeSelect
                id="leads-dealer-filter"
                value={superDealerFilter}
                onChange={(e) => setSuperDealerFilter(e.target.value)}
              >
                <option value="all">All dealers</option>
                {dealers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Manual follow-up</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && rows.length === 0 ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-muted/60" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No leads yet"
              action={
                <Button variant="outline" size="sm" asChild>
                  <Link href="/operations">Go to Operations</Link>
                </Button>
              }
            />
          ) : (
            <>
              <div className="space-y-3 md:hidden">
                {rows.map((r) => (
                  <LeadCard
                    key={r.id}
                    row={r}
                    showDealer={showDealerCol}
                    callPhase={callPhaseByInquiryId[r.id]}
                    onSave={(n) => void saveNotes(r.id, n)}
                    onCall={() => void callLead(r.id)}
                  />
                ))}
              </div>
              <div className="hidden md:block data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      {showDealerCol ? <th scope="col">Dealer</th> : null}
                      <th scope="col">Phone</th>
                      <th scope="col">Name</th>
                      <th scope="col">Category</th>
                      <th scope="col">Notes</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        {showDealerCol ? (
                          <td className="text-muted-foreground">{r.dealerName ?? "—"}</td>
                        ) : null}
                        <td className="font-medium">{r.phone}</td>
                        <td>{r.name}</td>
                        <td>{r.category}</td>
                        <td>
                          <NotesCell
                            initial={r.followUpNotes ?? ""}
                            onSave={(n) => void saveNotes(r.id, n)}
                          />
                        </td>
                        <td>
                          <div className="flex flex-col gap-2">
                            <Button size="sm" variant="outline" onClick={() => void callLead(r.id)}>
                              Click-to-call
                            </Button>
                            {callPhaseByInquiryId[r.id] ? (
                              <span className="text-xs text-muted-foreground">
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
              {nextCursor ? (
                <div className="mt-4 flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loading}
                    onClick={() => setCursor(nextCursor)}
                  >
                    {loading ? "Loading…" : "Load more"}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function LeadCard({
  row,
  showDealer,
  callPhase,
  onSave,
  onCall,
}: {
  row: InquiryRow;
  showDealer: boolean;
  callPhase?: string;
  onSave: (n: string) => void;
  onCall: () => void;
}) {
  return (
    <div className="roster-item">
      <div className="min-w-0 space-y-1">
        <p className="font-medium">{row.phone}</p>
        <p className="text-sm text-muted-foreground">{row.name ?? "—"} · {row.category}</p>
        {showDealer ? (
          <p className="text-xs text-muted-foreground">{row.dealerName ?? "—"}</p>
        ) : null}
        <NotesCell initial={row.followUpNotes ?? ""} onSave={onSave} />
      </div>
      <div className="flex shrink-0 flex-col gap-2">
        <Button size="sm" variant="outline" className="min-h-11" onClick={onCall}>
          Click-to-call
        </Button>
        {callPhase ? <span className="text-xs text-muted-foreground">{callPhase}</span> : null}
      </div>
    </div>
  );
}

function NotesCell({ initial, onSave }: { initial: string; onSave: (n: string) => void }) {
  const [v, setV] = useState(initial);
  const [saved, setSaved] = useState(false);
  return (
    <div className="flex gap-1">
      <Input
        value={v}
        onChange={(e) => setV(e.target.value)}
        className="h-9 min-h-11"
        aria-label="Follow-up notes"
      />
      <Button
        size="sm"
        type="button"
        variant="ghost"
        className="min-h-11 shrink-0"
        onClick={() => {
          onSave(v);
          setSaved(true);
          window.setTimeout(() => setSaved(false), 2000);
        }}
      >
        {saved ? "Saved" : "Save"}
      </Button>
      <span className="sr-only" aria-live="polite">
        {saved ? "Notes saved" : ""}
      </span>
    </div>
  );
}
