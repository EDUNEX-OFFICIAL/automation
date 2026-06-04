"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronDown, LogOut, Shield, User } from "lucide-react";
import { resolveAvatarSrc } from "@/lib/avatar";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth-session";
import { ROLE_LABELS, type AppRole } from "@/lib/roles";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";

export function AppUserMenu() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!user) return null;

  async function handleLogout(): Promise<void> {
    setBusy(true);
    try {
      await signOut();
      router.replace("/login");
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  const initials = (user.displayName?.trim() || user.username).slice(0, 2).toUpperCase();
  const roleLabel = ROLE_LABELS[user.role as AppRole] ?? user.role;
  const avatarSrc = resolveAvatarSrc(user.avatarUrl ?? null);
  const label = user.displayLabel?.trim() || user.displayName?.trim() || user.username;

  return (
    <div className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-10 gap-2.5 rounded-lg border-border/80 bg-card pl-2 pr-3.5 shadow-sm hover:bg-accent"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          {avatarSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarSrc} alt="" className="h-full w-full object-cover" />
          ) : (
            initials
          )}
        </span>
        <span className="hidden max-w-[9rem] truncate text-xs font-medium sm:inline">{label}</span>
        <ChevronDown
          className={cn("ml-0.5 h-4 w-4 shrink-0 text-muted-foreground transition", open && "rotate-180")}
        />
      </Button>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="menu"
            className="absolute right-0 z-50 mt-2 w-64 origin-top-right rounded-xl border border-border/80 bg-card p-1.5 shadow-elevated dark:shadow-elevated-dark"
          >
            <div className="border-b border-border px-3 py-3">
              <p className="truncate text-sm font-medium text-foreground">{label}</p>
              <p className="truncate text-xs text-muted-foreground">@{user.username}</p>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Shield className="h-3 w-3" />
                {roleLabel}
              </p>
            </div>
            <Link
              href="/profile"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-foreground transition hover:bg-muted"
              onClick={() => setOpen(false)}
            >
              <User className="h-4 w-4" />
              Profile
            </Link>
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => void handleLogout()}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
            >
              <LogOut className="h-4 w-4" />
              {busy ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
