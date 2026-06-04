"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { DashboardRouteGuard } from "@/components/dashboard-route-guard";
import { AppShell } from "@/components/app-shell";
import { PageLayout } from "@/components/layout/page-layout";
import { PageLoader } from "@/components/ui/page-loader";
import { useAuthStore } from "@/stores/auth-store";
import { usePersistReady } from "@/hooks/use-persist-ready";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const token = useAuthStore((s) => s.accessToken);
  const storageReady = usePersistReady();

  useEffect(() => {
    if (!storageReady) return;
    if (!token) router.replace("/login");
  }, [storageReady, token, router]);

  if (!storageReady) {
    return <PageLoader message="Loading workspace…" />;
  }
  if (!token) return null;
  return (
    <AppShell>
      <DashboardRouteGuard>
        <PageLayout>{children}</PageLayout>
      </DashboardRouteGuard>
    </AppShell>
  );
}
