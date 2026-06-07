"use client";

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type SettingsTabItem = {
  id: string;
  label: string;
  icon?: LucideIcon;
  accent?: "primary" | "success" | "warning";
};

type SettingsTabsProps = {
  tabs: SettingsTabItem[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
  /** Align tab bar to the right of its container */
  align?: "start" | "end";
  variant?: "default" | "premium";
};

const accentStyles = {
  primary: {
    active: "bg-primary/10 text-primary ring-1 ring-primary/25 shadow-sm shadow-primary/10",
    icon: "text-primary",
  },
  success: {
    active: "bg-emerald-500/10 text-emerald-700 ring-1 ring-emerald-500/25 shadow-sm shadow-emerald-500/10 dark:text-emerald-400",
    icon: "text-emerald-600 dark:text-emerald-400",
  },
  warning: {
    active: "bg-amber-500/10 text-amber-700 ring-1 ring-amber-500/25 shadow-sm shadow-amber-500/10 dark:text-amber-400",
    icon: "text-amber-600 dark:text-amber-400",
  },
} as const;

export function SettingsTabs({
  tabs,
  active,
  onChange,
  className,
  align = "start",
  variant = "default",
}: SettingsTabsProps) {
  const isPremium = variant === "premium";

  return (
    <div
      className={cn(
        "flex w-full",
        align === "end" ? "justify-end" : "justify-start",
        className,
      )}
    >
      <div
        className={cn(
          "inline-flex max-w-full gap-1 overflow-x-auto scrollbar-thin",
          isPremium
            ? "rounded-2xl border border-border/60 bg-card/80 p-1.5 shadow-card backdrop-blur-sm"
            : "rounded-xl border border-border/80 bg-muted/40 p-1",
        )}
        role="tablist"
      >
        {tabs.map((tab) => {
          const isActive = active === tab.id;
          const accent = tab.accent ? accentStyles[tab.accent] : null;
          const Icon = tab.icon;

          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={cn(
                "group relative flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium transition-all duration-200 sm:gap-2.5 sm:px-4 sm:py-2.5",
                isActive
                  ? isPremium && accent
                    ? accent.active
                    : "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
              onClick={() => onChange(tab.id)}
            >
              {Icon ? (
                <Icon
                  className={cn(
                    "h-4 w-4 shrink-0 transition-colors",
                    isActive && accent ? accent.icon : "text-muted-foreground group-hover:text-foreground",
                  )}
                  strokeWidth={2}
                />
              ) : null}
              <span className="whitespace-nowrap">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
