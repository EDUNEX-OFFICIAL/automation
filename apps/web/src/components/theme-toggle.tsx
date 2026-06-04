"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const THEME_CYCLE = ["light", "dark", "system"] as const;
type ThemeChoice = (typeof THEME_CYCLE)[number];

function nextTheme(current: string | undefined): ThemeChoice {
  const idx = THEME_CYCLE.indexOf((current ?? "system") as ThemeChoice);
  return THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
}

function themeLabel(choice: ThemeChoice, resolved: string | undefined): string {
  if (choice === "system") {
    return `System theme (currently ${resolved === "dark" ? "dark" : "light"})`;
  }
  if (choice === "dark") return "Dark mode";
  return "Light mode";
}

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const choice = (theme ?? "system") as ThemeChoice;
  const resolved = resolvedTheme ?? "light";

  const Icon =
    choice === "system" ? Monitor : choice === "dark" ? Moon : Sun;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground", className)}
      aria-label={themeLabel(choice, resolved)}
      title={themeLabel(choice, resolved)}
      disabled={!mounted}
      onClick={() => setTheme(nextTheme(theme))}
    >
      {mounted ? <Icon className="h-4 w-4" /> : <span className="h-4 w-4" />}
    </Button>
  );
}
