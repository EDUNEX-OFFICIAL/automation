"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import { OtpModal } from "@/components/otp-modal";
import { useRealtimeSocket } from "@/hooks/use-realtime-socket";

const nav = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/live-session", label: "Live session" },
  { href: "/leads", label: "Leads" },
  { href: "/settings", label: "Settings" },
  { href: "/users", label: "Users" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user } = useAuthStore();
  useRealtimeSocket();

  return (
    <div className="min-h-screen bg-zinc-50">
      <OtpModal />
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <span className="font-semibold text-zinc-900">GDMS Automation</span>
          <nav className="flex gap-1 text-sm">
            {nav.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  "rounded-md px-3 py-2 text-zinc-600 hover:bg-zinc-100",
                  pathname?.startsWith(n.href) && "bg-zinc-100 font-medium text-zinc-900",
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="text-xs text-zinc-500">
            <span>{user?.email}</span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
