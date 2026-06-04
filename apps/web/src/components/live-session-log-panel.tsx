"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatLogTimestamp } from "@/lib/automation-log-present";
import { runStatusLabel, userFacingLogMessage } from "@/lib/automation-log-user";
import { cn } from "@/lib/utils";

type LogEntry = { level: string; message: string; ts: string };

function rowTone(level: string): string {
  if (level === "error") {
    return "border-l-red-500 bg-red-500/10 dark:bg-red-500/15";
  }
  if (level === "warn") {
    return "border-l-amber-500 bg-amber-500/10 dark:bg-amber-500/15";
  }
  return "border-l-border bg-muted/50 dark:bg-muted/30";
}

export type LiveSessionLogPanelProps = {
  logs: LogEntry[];
  runStatus: string | null | undefined;
  prominentError: string | null | undefined;
  onClearLogs?: () => void;
};

export function LiveSessionLogPanel({
  logs,
  runStatus,
  prominentError,
  onClearLogs,
}: LiveSessionLogPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const lastLogKey = logs.length > 0 ? `${logs[logs.length - 1]?.ts}-${logs.length}` : "0";

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lastLogKey]);

  async function copyLogs(): Promise<void> {
    const body = logs
      .map((l) => `${formatLogTimestamp(l.ts)}\t${userFacingLogMessage(l.message)}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard may be denied */
    }
  }

  const attention =
    runStatus === "FAILED" || runStatus === "PAUSED_USER" || runStatus === "STOPPED";

  return (
    <Card className="flex min-h-[320px] flex-col lg:max-h-[calc(100vh-12rem)]">
      <CardHeader className="shrink-0 space-y-2 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Activity log</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              disabled={logs.length === 0}
              onClick={() => void copyLogs()}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
            {onClearLogs ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                disabled={logs.length === 0}
                onClick={onClearLogs}
              >
                Clear
              </Button>
            ) : null}
          </div>
        </div>
        {runStatus ? (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Status:</span> {runStatusLabel(runStatus)}
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-2 text-sm">
        {prominentError && attention ? (
          <div
            className={cn(
              "shrink-0 rounded border px-2 py-2 text-xs",
              runStatus === "STOPPED"
                ? "border-border bg-muted text-foreground"
                : "border-destructive/30 bg-destructive/10 text-foreground",
            )}
          >
            <span className="break-words">{prominentError}</span>
          </div>
        ) : null}

        <div
          ref={scrollRef}
          className="min-h-[220px] flex-1 overflow-y-auto overscroll-contain rounded-md border border-border bg-muted/40"
        >
          <div className="divide-y divide-border">
            {logs.length === 0 ? (
              <p className="p-4 text-center text-xs text-muted-foreground">No activity yet.</p>
            ) : (
              logs.map((l, i) => (
                <div
                  key={`${l.ts}-${i}`}
                  className={cn("border-l-4 px-3 py-2 text-xs", rowTone(l.level))}
                >
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <time className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {formatLogTimestamp(l.ts)}
                    </time>
                    <span className="min-w-0 flex-[1_1_100%] break-words text-foreground sm:flex-[unset]">
                      {userFacingLogMessage(l.message)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
