"use client";

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type ChartCardProps = {
  title: string;
  description?: string;
  icon?: LucideIcon;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
};

export function ChartCard({ title, description, icon: Icon, children, className, action }: ChartCardProps) {
  return (
    <article
      className={cn(
        "flex flex-col overflow-hidden rounded-2xl border border-border/70 bg-card shadow-card transition-shadow hover:shadow-md",
        className,
      )}
    >
      <header className="flex items-start justify-between gap-3 border-b border-border/50 px-4 py-3.5 sm:px-5 sm:py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {Icon ? (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon className="h-4 w-4" strokeWidth={2} />
              </span>
            ) : null}
            <h3 className="truncate text-sm font-semibold tracking-tight text-foreground sm:text-[15px]">
              {title}
            </h3>
          </div>
          {description ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      <div className="min-h-0 flex-1 p-3 sm:p-4">{children}</div>
    </article>
  );
}
