"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { AutomationStatsPanel } from "@/components/dashboard/automation-stats-panel";
import { apiFetch } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";

export default function PlatformAnalyticsPage() {
  const router = useRouter();
  const token = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const [dealers, setDealers] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (!token) router.replace("/login");
  }, [token, router]);

  useEffect(() => {
    if (!token) return;
    void apiFetch<{ id: string; name: string }[]>("/v1/dealers", { token })
      .then(setDealers)
      .catch(() => setDealers([]));
  }, [token]);

  if (!token) return null;

  return (
    <>
      <PageHeader
        title="Platform Analytics"
        eyebrow="Super Admin"
        description="Dealer-wise and team-wise automation KPIs across all tenants."
      />
      <AutomationStatsPanel
        token={token}
        role={user?.role}
        dealers={dealers}
        showDealerPicker
      />
    </>
  );
}
