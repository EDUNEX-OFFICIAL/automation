"use client";

import { cn } from "@/lib/utils";

type MenuToggleProps = {
  open: boolean;
  onClick: () => void;
  className?: string;
};

export function MenuToggle({ open, onClick, className }: MenuToggleProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-label={open ? "Close menu" : "Open menu"}
      className={cn(
        "menu-toggle relative flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-card text-foreground shadow-sm transition hover:bg-muted",
        open && "menu-toggle-active",
        className,
      )}
    >
      <span className="menu-toggle-bar menu-toggle-bar-1" />
      <span className="menu-toggle-bar menu-toggle-bar-2" />
      <span className="menu-toggle-bar menu-toggle-bar-3" />
    </button>
  );
}
