"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";

type NotificationPayload = {
  runId?: string;
  dealerId?: string;
};

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  readAt: string | null;
  payload: NotificationPayload | null;
  createdAt: string;
};

function notificationHref(n: NotificationRow): string {
  const runId = n.payload?.runId;
  if (runId) return `/live-session?runId=${encodeURIComponent(runId)}`;
  if (n.type === "OTP_REQUIRED" || n.type.startsWith("WORKFLOW_")) return "/live-session";
  return "/dashboard";
}

export function NotificationBell({ className }: { className?: string }) {
  const router = useRouter();
  const token = useAuthStore((s) => s.accessToken);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)));
    setUnread((c) => Math.max(0, c - 1));
  }

  async function deleteNotification(id: string): Promise<void> {
    if (!token || deletingId) return;
    setDeletingId(id);
    try {
      await apiFetch(`/v1/notifications/${id}`, { method: "DELETE", token });
      const removed = items.find((n) => n.id === id);
      setItems((prev) => prev.filter((n) => n.id !== id));
      if (removed && !removed.readAt) setUnread((c) => Math.max(0, c - 1));
    } catch {
      void load();
    } finally {
      setDeletingId(null);
    }
  }

  async function openNotification(n: NotificationRow): Promise<void> {
    if (!n.readAt) await markRead(n.id).catch(() => undefined);
    setOpen(false);
    router.push(notificationHref(n));
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
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default"
            aria-label="Close notifications"
            onClick={() => setOpen(false)}
          />
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
                  <li key={n.id} className="group flex items-stretch gap-0.5">
                    <button
                      type="button"
                      className={cn(
                        "min-w-0 flex-1 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-muted/60",
                        !n.readAt && "bg-primary/5",
                      )}
                      onClick={() => void openNotification(n)}
                    >
                      <p className="font-medium leading-snug">{n.title}</p>
                      {n.body ? (
                        <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{n.body}</p>
                      ) : null}
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-auto w-8 shrink-0 self-center opacity-60 hover:text-destructive group-hover:opacity-100"
                      aria-label="Delete notification"
                      disabled={deletingId === n.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteNotification(n.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </>
      ) : null}
    </div>
  );
}
