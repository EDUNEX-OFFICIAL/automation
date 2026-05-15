"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { usePersistReady } from "@/hooks/use-persist-ready";

export default function Home() {
  const router = useRouter();
  const token = useAuthStore((s) => s.accessToken);
  const storageReady = usePersistReady();

  useEffect(() => {
    if (!storageReady) return;
    router.replace(token ? "/dashboard" : "/login");
  }, [storageReady, token, router]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-zinc-100 px-4 text-center text-sm text-zinc-600">
      <p>{!storageReady ? "Loading…" : "Redirecting…"}</p>
      <p className="max-w-sm text-xs text-zinc-400">
        Agar yahan atka rahe: browser DevTools → Application → Local Storage → is origin par{" "}
        <code className="rounded bg-zinc-200 px-1">gdms-auth</code> entry delete karke refresh karo (corrupt
        JSON kabhi rehydrate fail karata hai).
      </p>
    </div>
  );
}
