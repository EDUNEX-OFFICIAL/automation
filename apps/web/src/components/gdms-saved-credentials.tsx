"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatGdmsSavedAt, type GdmsAccountSummary } from "@/lib/gdms-account";

type Props = {
  accounts: GdmsAccountSummary[];
  loading?: boolean;
  selectedDealerId?: string;
  onSelectDealer?: (dealerId: string) => void;
};

export function GdmsSavedCredentials({
  accounts,
  loading,
  selectedDealerId,
  onSelectDealer,
}: Props) {
  const configured = accounts.filter((a) => a.configured);
  const showDealerColumn = accounts.length > 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Saved GDMS credentials</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-zinc-500">Loading saved credentials…</p>
        ) : configured.length === 0 ? (
          <p className="text-sm text-zinc-600">
            No GDMS login saved yet. Add credentials below for your dealer.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[320px] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-zinc-500">
                  {showDealerColumn && <th className="py-2 pr-4 font-medium">Dealer</th>}
                  <th className="py-2 pr-4 font-medium">Username</th>
                  <th className="py-2 pr-4 font-medium">Last saved</th>
                  {onSelectDealer && <th className="py-2 font-medium" />}
                </tr>
              </thead>
              <tbody>
                {configured.map((row) => (
                  <tr key={row.dealerId} className="border-b border-zinc-100 last:border-0">
                    {showDealerColumn && (
                      <td className="py-2.5 pr-4 font-medium text-zinc-900">{row.dealerName}</td>
                    )}
                    <td className="py-2.5 pr-4 font-mono text-zinc-800">{row.usernameMasked ?? "—"}</td>
                    <td className="py-2.5 pr-4 text-zinc-600">{formatGdmsSavedAt(row.updatedAt)}</td>
                    {onSelectDealer && (
                      <td className="py-2.5 text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={selectedDealerId === row.dealerId}
                          onClick={() => onSelectDealer(row.dealerId)}
                        >
                          {selectedDealerId === row.dealerId ? "Editing" : "Update"}
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && accounts.some((a) => !a.configured) && configured.length > 0 && (
          <p className="mt-3 text-xs text-zinc-500">
            {accounts.filter((a) => !a.configured).length} dealer
            {accounts.filter((a) => !a.configured).length === 1 ? "" : "s"} still need GDMS credentials.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
