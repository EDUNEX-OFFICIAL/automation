"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLiveStore } from "@/stores/live-store";
import { useAuthStore } from "@/stores/auth-store";
import { apiFetch, checkApiHealth } from "@/lib/api";
import { toUserMessage } from "@/lib/user-messages";
import { useAutomationSessionStore } from "@/stores/automation-session-store";

type OtpEntryPanelProps = {
  variant?: "bar" | "card";
  className?: string;
};

/** Persistent OTP entry — not a dialog (dialogs were closing after a few seconds). */
export function OtpEntryPanel({ variant = "bar", className }: OtpEntryPanelProps) {
  const otpPending = useLiveStore((s) => s.otpPending);
  const otpRunId = useLiveStore((s) => s.otpRunId);
  const closeOtp = useLiveStore((s) => s.closeOtp);
  const token = useAuthStore((s) => s.accessToken);
  const userId = useAuthStore((s) => s.user?.id);
  const markOtpVerified = useAutomationSessionStore((s) => s.markOtpVerified);
  const [otp, setOtp] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  if (!otpPending) return null;

  async function submit(): Promise<void> {
    const code = otp.replace(/\s+/g, "").trim();
    if (!token || !otpRunId) {
      setErr("Session missing. Refresh the page and try again.");
      return;
    }
    if (code.length < 4) {
      setErr("Enter at least 4 characters.");
      return;
    }
    setErr(null);
    setOkMsg(null);
    setPending(true);
    try {
      await checkApiHealth();
      await apiFetch(`/v1/workflow-runs/${otpRunId}/otp`, {
        method: "POST",
        token,
        body: JSON.stringify({ otp: code }),
      });
      if (userId) markOtpVerified(userId);
      setOkMsg("Submitted — automation is continuing.");
      setOtp("");
      window.setTimeout(() => {
        closeOtp();
        setOkMsg(null);
      }, 1500);
    } catch (e) {
      setErr(toUserMessage(e, "network"));
    } finally {
      setPending(false);
    }
  }

  const inner = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-semibold text-foreground">GDMS OTP required</p>
      </div>
      <div className="flex w-full min-w-0 flex-1 flex-col gap-2 sm:max-w-md">
        <Input
          placeholder="OTP"
          value={otp}
          onChange={(e) => setOtp(e.target.value)}
          disabled={pending}
          autoFocus
          className="bg-card"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !pending) void submit();
          }}
        />
        {err ? <p className="text-xs text-destructive">{err}</p> : null}
        {okMsg ? <p className="text-xs text-emerald-600 dark:text-emerald-400">{okMsg}</p> : null}
      </div>
      <Button onClick={() => void submit()} disabled={pending} className="shrink-0">
        {pending ? "Submitting…" : "Submit OTP"}
      </Button>
    </div>
  );

  if (variant === "card") {
    return (
      <div
        className={
          className ??
          "panel-warning border-2 border-amber-500/30 px-4 py-4 shadow-sm"
        }
      >
        {inner}
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="GDMS OTP entry"
      className={
        className ??
        "fixed bottom-0 left-0 right-0 z-[60] border-t border-amber-500/30 bg-card/95 px-4 py-4 shadow-elevated backdrop-blur-xl lg:left-[var(--sidebar-width)]"
      }
    >
      <div className="mx-auto max-w-[88rem]">{inner}</div>
    </div>
  );
}
