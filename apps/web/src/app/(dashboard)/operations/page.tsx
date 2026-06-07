"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { OperationsWorkspace } from "@/components/operations/operations-workspace";
import { canRunAutomation } from "@/lib/roles";
import { useAuthStore } from "@/stores/auth-store";

export default function OperationsPage() {
  const router = useRouter();
  const token = useAuthStore((s) => s.accessToken);
  const role = useAuthStore((s) => s.user?.role);

  useEffect(() => {
    if (!token) router.replace("/login");
    else if (!canRunAutomation(role)) router.replace("/dashboard");
  }, [token, role, router]);

  if (!token || !canRunAutomation(role)) return null;

  return (
    <div className="page-stack">
      <PageHeader
        title="Operations"
        eyebrow="Automation workspace"
        description="Start enquiry transfer, follow up skip, and lost inquiry runs."
      />
      <OperationsWorkspace />
    </div>
  );
}
