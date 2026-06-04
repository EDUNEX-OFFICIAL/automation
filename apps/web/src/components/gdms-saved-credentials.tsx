"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ShieldCheck } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { formatGdmsSavedAt, roleLabel, type GdmsAccountSummary } from "@/lib/gdms-account";

type Props = {
  accounts: GdmsAccountSummary[];
  loading?: boolean;
  selectedUserId?: string;
  onSelectUser?: (userId: string) => void;
  title?: string;
};

export function GdmsSavedCredentials({
  accounts,
  loading,
  selectedUserId,
  onSelectUser,
  title = "GDMS credentials",
}: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : accounts.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No team members" />
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>GDMS login</th>
                  <th>Last saved</th>
                  {onSelectUser ? <th className="text-right">Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {accounts.map((row) => (
                  <tr key={row.userId}>
                    <td className="font-medium text-foreground">{row.username}</td>
                    <td className="text-muted-foreground">{roleLabel(row.role)}</td>
                    <td className="font-mono text-foreground">
                      {row.configured ? (row.usernameMasked ?? "Saved") : "—"}
                    </td>
                    <td className="text-muted-foreground">
                      {row.configured ? formatGdmsSavedAt(row.updatedAt) : "—"}
                    </td>
                    {onSelectUser ? (
                      <td className="text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={selectedUserId === row.userId}
                          onClick={() => onSelectUser(row.userId)}
                        >
                          {selectedUserId === row.userId ? "Editing" : "Set creds"}
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
