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
        "menu-toggle relative flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-800 shadow-sm transition hover:border-zinc-300 hover:bg-zinc-50",
        open && "menu-toggle-active border-zinc-300 bg-zinc-50",
        className,
      )}
    >
      <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
      <span className="menu-toggle-bar menu-toggle-bar-1" aria-hidden />
      <span className="menu-toggle-bar menu-toggle-bar-2" aria-hidden />
      <span className="menu-toggle-bar menu-toggle-bar-3" aria-hidden />
    </button>
  );
}
