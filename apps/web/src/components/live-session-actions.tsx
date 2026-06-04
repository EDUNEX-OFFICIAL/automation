"use client";

import { useState } from "react";
import Link from "next/link";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type LiveSessionActionsProps = {
  children: React.ReactNode;
  className?: string;
};

/** Primary actions visible; overflow on small screens. */
export function LiveSessionActions({ children, className }: LiveSessionActionsProps) {
  const [open, setOpen] = useState(false);
  const items = Array.isArray(children) ? children : [children];

  return (
    <div className={cn("relative flex flex-wrap items-center gap-2", className)}>
      <div className="hidden flex-wrap items-center gap-2 md:flex">{items}</div>
      <div className="flex flex-wrap items-center gap-2 md:hidden">
        {items.slice(0, 2)}
        {items.length > 2 ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={open}
              aria-haspopup="true"
              onClick={() => setOpen((v) => !v)}
            >
              <MoreHorizontal className="h-4 w-4" />
              <span className="sr-only">More actions</span>
            </Button>
            {open ? (
              <div
                className="absolute right-0 top-full z-30 mt-1 flex min-w-[10rem] flex-col gap-1 rounded-xl border border-border bg-card p-1.5 shadow-elevated"
                role="menu"
              >
                {items.slice(2).map((child, i) => (
                  <div key={i} role="none" className="[&>button]:w-full [&>a]:w-full">
                    {child}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export { Link };
