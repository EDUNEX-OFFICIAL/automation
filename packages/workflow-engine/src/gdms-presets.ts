import type { WorkflowDefinition } from "./types.js";

/** Presets use env-driven selectors; replace placeholders after mapping real GDMS DOM. */
export const GDMS_SELECTOR_ENV = {
  loginUser: "GDMS_SEL_LOGIN_USER",
  loginPass: "GDMS_SEL_LOGIN_PASS",
  /** First click before OTP — HMIL Hyundai: “Send OTP” */
  otpSendButton: "GDMS_SEL_OTP_SEND",
  otpInput: "GDMS_SEL_OTP_INPUT",
  /** After OTP filled — HMIL Hyundai: blue “Login” */
  finalLoginButton: "GDMS_SEL_FINAL_LOGIN",
  /** @deprecated Prefer GDMS_SEL_OTP_SEND — kept as alias for overrides */
  loginSubmit: "GDMS_SEL_LOGIN_SUBMIT",
  /** @deprecated Prefer GDMS_SEL_FINAL_LOGIN — Kept as alias */
  otpSubmit: "GDMS_SEL_OTP_SUBMIT",
  inquiryRow: "GDMS_SEL_INQUIRY_ROW",
  transferButton: "GDMS_SEL_TRANSFER",
  statusSelect: "GDMS_SEL_STATUS",
} as const;

export function defaultLoginWorkflow(baseUrl: string): WorkflowDefinition {
  /** `pw:ph|…` / `pw:btn|…` resolved by automation-service runner (Playwright). */
  const sendOtp =
    process.env[GDMS_SELECTOR_ENV.otpSendButton] ??
    process.env[GDMS_SELECTOR_ENV.loginSubmit] ??
    "pw:btn|Send OTP";
  const otpField = process.env[GDMS_SELECTOR_ENV.otpInput] ?? "pw:ph|Enter OTP";
  const finalizeLogin =
    process.env[GDMS_SELECTOR_ENV.finalLoginButton] ??
    process.env[GDMS_SELECTOR_ENV.otpSubmit] ??
    "pw:btn|Login";

  return {
    version: "1",
    name: "gdms_login_otp",
    steps: [
      { id: "open", type: "navigate", label: "Open GDMS", url: baseUrl },
      {
        id: "user",
        type: "fill",
        label: "Enter User ID",
        selector: process.env[GDMS_SELECTOR_ENV.loginUser] ?? "pw:ph|User ID",
        valueFrom: "gdmsUsername",
      },
      {
        id: "pass",
        type: "fill",
        label: "Enter password",
        selector: process.env[GDMS_SELECTOR_ENV.loginPass] ?? "pw:ph|Password",
        valueFrom: "gdmsPassword",
      },
      {
        id: "send_otp",
        type: "click",
        label: "Send OTP",
        selector: sendOtp,
      },
      {
        id: "otp_gate",
        type: "wait_for_otp",
        label: "Wait for OTP from user (dashboard modal)",
        selector: otpField,
        timeoutMs: 600_000,
      },
      {
        id: "otp_fill",
        type: "fill",
        label: "Enter OTP into GDMS",
        selector: otpField,
        valueFrom: "otp",
      },
      {
        id: "final_login",
        type: "click",
        label: "Login after OTP",
        selector: finalizeLogin,
      },
    ],
  };
}

export function inquiryFetchWorkflow(listUrl: string): WorkflowDefinition {
  return {
    version: "1",
    name: "inquiry_fetch",
    steps: [
      { id: "open_list", type: "navigate", label: "Open inquiry list", url: listUrl },
      {
        id: "wait_rows",
        type: "wait_selector",
        label: "Wait for inquiry rows",
        selector: process.env[GDMS_SELECTOR_ENV.inquiryRow] ?? "table tbody tr",
        timeoutMs: 120_000,
      },
    ],
  };
}
