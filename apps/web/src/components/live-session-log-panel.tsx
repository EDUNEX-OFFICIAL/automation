"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatLogTimestamp,
  parseAutomationLogLine,
  type AutomationLogCategory,
} from "@/lib/automation-log-present";
import { runStatusLabel, userFacingLogMessage } from "@/lib/automation-log-user";
import { cn } from "@/lib/utils";

type LogEntry = { level: string; message: string; ts: string };

function rowTone(level: string, category: AutomationLogCategory): string {
  if (level === "error") return "border-l-red-500 bg-red-50/50";
  if (level === "warn") return "border-l-amber-500 bg-amber-50/40";
  if (category === "save") return "border-l-emerald-600/70 bg-emerald-50/35";
  if (category === "pin" || category === "match") return "border-l-violet-600/70 bg-violet-50/35";
  if (category === "navigation" || category === "search") return "border-l-sky-600/70 bg-sky-50/35";
  if (category === "follow-up" || category === "form") return "border-l-orange-600/70 bg-orange-50/30";
  return "border-l-zinc-300 bg-white";
}

export type LiveSessionLogPanelProps = {
  logs: LogEntry[];
  lastStepLabel: string | null;
  apiCurrentStep: string | null;
  runStatus: string | null | undefined;
  prominentError: string | null | undefined;
  onClearLogs?: () => void;
};

export function LiveSessionLogPanel({
  logs,
  lastStepLabel,
  apiCurrentStep,
  runStatus,
  prominentError,
  onClearLogs,
}: LiveSessionLogPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs.length]);

  async function copyLogs(): Promise<void> {
    const body = logs
      .map((l) => `${formatLogTimestamp(l.ts)}\t${l.level.toUpperCase()}\t${l.message}`)
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
      <CardHeader className="shrink-0 space-y-1 pb-2">
        <CardTitle className="text-base">Automation log</CardTitle>
        <p className="text-xs font-normal leading-snug text-zinc-500">
          Local time · newest at bottom · GDMS labels like{" "}
          <span className="font-mono text-zinc-700">* PIN</span> /{" "}
          <span className="font-mono text-zinc-700">* Verification</span> mean mandatory (
          <span className="font-mono">*</span>, not the word &quot;Star&quot;).
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-fit text-xs"
            onClick={() => void copyLogs()}
          >
            {copied ? "Copied" : "Copy full log"}
          </Button>
          {onClearLogs ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-fit text-xs"
              disabled={logs.length === 0}
              onClick={onClearLogs}
            >
              Clear log
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 text-sm">
        {runStatus ? (
          <div className="shrink-0 space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs">
            <div className="grid gap-2 sm:grid-cols-1">
              <p>
                <span className="font-semibold text-zinc-700">Run status:</span>{" "}
                <span>{runStatusLabel(runStatus)}</span>
              </p>
              <p>
                <span className="font-semibold text-zinc-700">Workflow step (API):</span>{" "}
                <span className="break-all text-zinc-800">{apiCurrentStep ?? "—"}</span>
              </p>
              <p>
                <span className="font-semibold text-zinc-700">Last UI step (socket):</span>{" "}
                <span className="break-all text-zinc-800">{lastStepLabel ?? "—"}</span>
              </p>
            </div>
            {prominentError && attention ? (
              <div
                className={cn(
                  "rounded border px-2 py-2",
                  runStatus === "STOPPED"
                    ? "border-zinc-300 bg-zinc-100 text-zinc-900"
                    : "border-red-200 bg-red-50 text-red-900",
                )}
              >
                <span className="font-semibold">
                  {runStatus === "PAUSED_USER"
                    ? "Paused — "
                    : runStatus === "STOPPED"
                      ? "Stopped — "
                      : "Failed — "}
                </span>
                <span className="break-words">{prominentError}</span>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="min-h-[220px] flex-1 overflow-y-auto rounded-md border border-zinc-200 bg-zinc-50/80">
          <div className="divide-y divide-zinc-100">
            {logs.length === 0 ? (
              <p className="p-4 text-center text-xs text-zinc-500">
                Logs appear here when automation emits progress (login, enquiry transfer, saves).
              </p>
            ) : (
              logs.map((l, i) => {
                const parsed = parseAutomationLogLine(l.message);
                const tone = rowTone(l.level, parsed.category);
                return (
                  <div key={`${l.ts}-${i}`} className={cn("border-l-4 px-3 py-2 text-xs", tone)}>
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <time className="shrink-0 font-mono text-[10px] text-zinc-500">
                        {formatLogTimestamp(l.ts)}
                      </time>
                      <span className="rounded bg-white/90 px-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-zinc-700 ring-1 ring-zinc-200">
                        {parsed.badge}
                      </span>
                      <span className="font-mono text-[10px] uppercase text-zinc-500">{l.level}</span>
                      <span className="min-w-0 flex-[1_1_100%] break-words font-medium text-zinc-900 sm:flex-[unset]">
                        {userFacingLogMessage(l.message)}
                      </span>
                    </div>
                    {parsed.hint ? (
                      <p className="mt-1.5 border-l-2 border-zinc-400/60 pl-2 text-[11px] leading-relaxed text-zinc-700">
                        <span className="font-medium text-zinc-600">Where / why: </span>
                        {parsed.hint}
                      </p>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
          <div ref={bottomRef} className="h-px w-full shrink-0 scroll-mt-24" aria-hidden />
        </div>
      </CardContent>
    </Card>
  );
}
