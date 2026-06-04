"use client";

import { cn } from "@/lib/utils";

type SettingsTabsProps = {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
};

export function SettingsTabs({ tabs, active, onChange, className }: SettingsTabsProps) {
  return (
    <div
      className={cn(
        "flex gap-1 overflow-x-auto rounded-xl border border-border/80 bg-muted/40 p-1 scrollbar-thin",
        className,
      )}
      role="tablist"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          className={cn(
            "shrink-0 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
            active === tab.id
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
