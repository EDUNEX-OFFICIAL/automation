"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/app-shell";
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
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-100 text-sm text-zinc-500">
        …
      </div>
    );
  }
  if (!token) return null;
  return <AppShell>{children}</AppShell>;
}
