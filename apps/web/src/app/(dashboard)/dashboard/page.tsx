"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { canViewAutomationStats } from "@/lib/roles";
import { AutomationStatsPanel } from "@/components/dashboard/automation-stats-panel";
import { useAuthStore } from "@/stores/auth-store";

export default function DashboardPage() {
  const router = useRouter();
  const token = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const [dealers, setDealers] = useState<{ id: string; name: string }[]>([]);
  const [dealerId, setDealerId] = useState<string>("");

  useEffect(() => {
    if (!token) router.replace("/login");
  }, [token, router]);

  useEffect(() => {
    if (!token) return;
    void apiFetch<{ id: string; name: string }[]>("/v1/dealers", { token }).then((d) => {
      setDealers(d);
      if (user?.dealerId) {
        setDealerId(user.dealerId);
      } else if (d[0]) {
        setDealerId((prev) => prev || d[0]!.id);
      }
    });
  }, [token, user?.dealerId]);

  if (!token) return null;

  const showStats = canViewAutomationStats(user?.role);

  if (!showStats) return null;

  return (
    <AutomationStatsPanel
      token={token}
      role={user?.role}
      dealerId={dealerId || user?.dealerId || undefined}
      dealers={dealers}
      showDealerPicker={user?.role === "SUPER_ADMIN" && dealers.length > 1}
      className="-mt-1 sm:-mt-2"
    />
  );
}
