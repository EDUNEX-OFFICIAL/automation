"use client";

import { usePathname } from "next/navigation";
import { OtpEntryPanel } from "@/components/otp-entry-panel";

/** Fixed bottom OTP bar on pages other than Live session (card shown there). */
export function OtpModal() {
  const path = usePathname();
  if (path?.startsWith("/live-session")) return null;
  return <OtpEntryPanel variant="bar" />;
}
