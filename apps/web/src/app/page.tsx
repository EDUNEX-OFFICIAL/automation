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
  return null;
}
