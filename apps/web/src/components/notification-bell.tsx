"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
};

export function NotificationBell({ className }: { className?: string }) {
  const token = useAuthStore((s) => s.accessToken);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!token) return;
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(t);
  }, [token]);

  async function load(): Promise<void> {
    if (!token) return;
    try {
      const data = await apiFetch<{ items: NotificationRow[]; unreadCount: number }>(
        "/v1/notifications",
        { token },
      );
      setItems(data.items);
      setUnread(data.unreadCount);
    } catch {
      /* ignore */
    }
  }

  async function markRead(id: string): Promise<void> {
    if (!token) return;
    await apiFetch(`/v1/notifications/${id}/read`, { method: "POST", token, body: "{}" });
    void load();
  }

  return (
    <div className={cn("relative", className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="relative h-9 w-9"
        aria-label={unread ? `${unread} unread notifications` : "Notifications"}
        onClick={() => setOpen((v) => !v)}
      >
        <Bell className="h-4 w-4" />
        {unread > 0 ? (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </Button>
      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-80 rounded-xl border border-border bg-card p-2 shadow-elevated">
          <div className="mb-2 flex items-center justify-between px-2">
            <p className="text-sm font-semibold">Notifications</p>
            <Link href="/live-session" className="text-xs text-primary" onClick={() => setOpen(false)}>
              Live session
            </Link>
          </div>
          <ul className="max-h-72 space-y-1 overflow-y-auto scrollbar-thin">
            {items.length === 0 ? (
              <li className="px-2 py-6 text-center text-sm text-muted-foreground">All caught up</li>
            ) : (
              items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={cn(
                      "w-full rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-muted/60",
                      !n.readAt && "bg-primary/5",
                    )}
                    onClick={() => void markRead(n.id)}
                  >
                    <p className="font-medium">{n.title}</p>
                    {n.body ? <p className="text-xs text-muted-foreground">{n.body}</p> : null}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
