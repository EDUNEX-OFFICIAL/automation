"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { usePersistReady } from "@/hooks/use-persist-ready";

function LoadingSpinner() {
  return (
    <div
      className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-700"
      aria-hidden
    />
  );
}

export default function Home() {
  const router = useRouter();
  const token = useAuthStore((s) => s.accessToken);
  const storageReady = usePersistReady();

  useEffect(() => {
    if (!storageReady) return;
    router.replace(token ? "/dashboard" : "/login");
  }, [storageReady, token, router]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-zinc-50 px-4">
      <LoadingSpinner />
      <p className="text-sm text-zinc-600">{!storageReady ? "Loading…" : "Redirecting…"}</p>
    </div>
  );
}
