"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useLiveStore } from "@/stores/live-store";
import { useAuthStore } from "@/stores/auth-store";
import { apiFetch, checkApiHealth } from "@/lib/api";
import { toUserMessage } from "@/lib/user-messages";
import { useAutomationSessionStore } from "@/stores/automation-session-store";

export function OtpModal() {
  const otpOpen = useLiveStore((s) => s.otpOpen);
  const otpRunId = useLiveStore((s) => s.otpRunId);
  const closeOtp = useLiveStore((s) => s.closeOtp);
  const token = useAuthStore((s) => s.accessToken);
  const dealerId = useAuthStore((s) => s.user?.dealerId);
  const markOtpVerified = useAutomationSessionStore((s) => s.markOtpVerified);
  const [otp, setOtp] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const code = otp.replace(/\s+/g, "").trim();
    if (!token || !otpRunId) {
      setErr("Session or run id is missing. Open Live session or sign in again.");
      return;
    }
    if (code.length < 4) {
      setErr("OTP must be at least 4 characters.");
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
      if (dealerId) markOtpVerified(dealerId);
      setOkMsg(
        "OTP sent to automation. It will fill the GDMS form and continue. Check Live session or logs for progress.",
      );
      await new Promise((r) => setTimeout(r, 900));
      closeOtp();
      setOtp("");
      setOkMsg(null);
    } catch (e) {
      setErr(toUserMessage(e, "network"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={otpOpen}
      onOpenChange={(o) => {
        if (!o && !pending) {
          closeOtp();
          setErr(null);
          setOkMsg(null);
        }
      }}
    >
      <DialogContent>
        <DialogTitle>GDMS OTP</DialogTitle>
        <p className="text-sm text-zinc-600">
          Enter the OTP GDMS sent by SMS or email. After you submit, automation will fill the same
          value in the GDMS form.
        </p>
        <Input
          placeholder="6-digit OTP"
          value={otp}
          onChange={(e) => setOtp(e.target.value)}
          disabled={pending}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !pending) void submit();
          }}
        />
        {err && <p className="text-sm text-red-600">{err}</p>}
        {okMsg && <p className="text-sm text-green-700">{okMsg}</p>}
        <DialogFooter>
          <Button onClick={() => void submit()} disabled={pending}>
            {pending ? "Submitting…" : "Submit OTP"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
