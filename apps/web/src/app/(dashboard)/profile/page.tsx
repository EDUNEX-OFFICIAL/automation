"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { UserProfileForm } from "@/components/user-profile-form";
import { useAuthStore } from "@/stores/auth-store";

export default function ProfilePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const syncUserFromApi = useAuthStore((s) => s.syncUserFromApi);

  const editUserId = searchParams.get("userId") ?? user?.id ?? "";
  const isSelf = editUserId === user?.id;

  useEffect(() => {
    if (!token) router.replace("/login");
  }, [token, router]);

  if (!token || !user || !editUserId) return null;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8">
      <PageHeader
        eyebrow="Account"
        title={isSelf ? "Profile" : "Edit team member"}
        actions={
          !isSelf ? (
            <Link
              href="/profile"
              className="inline-flex h-10 items-center rounded-lg border border-input bg-card px-4 text-sm font-medium hover:bg-muted/60"
            >
              Back to my profile
            </Link>
          ) : null
        }
      />
      <UserProfileForm
        token={token}
        userId={editUserId}
        isSelf={isSelf}
        onSaved={() => {
          if (isSelf) {
            void import("@/lib/api").then(({ apiFetch }) =>
              apiFetch("/v1/me", { token }).then((me) => syncUserFromApi(me as typeof user)),
            );
          }
        }}
      />
    </div>
  );
}
