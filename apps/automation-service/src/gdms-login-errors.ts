import type { Page } from "playwright";

/** HMIL / Hyundai DMS login failure copy — match before pausing for OTP. */
export const GDMS_LOGIN_ERROR_PATTERNS: RegExp[] = [
  /please\s+check\s+user\s*id\s+or\s+password/i,
  /invalid\s+user\s*id/i,
  /incorrect\s+password/i,
  /user\s*id\s+or\s+password/i,
  /authentication\s+failed/i,
  /login\s+failed/i,
];

/**
 * After "Send OTP", GDMS shows credential errors instead of sending OTP when User ID/password are wrong.
 * Returns the matched message or null if no login error is visible.
 */
export async function detectGdmsLoginError(page: Page, settleMs = 3000): Promise<string | null> {
  await page.waitForTimeout(settleMs);

  const bodyText = await page
    .locator("body")
    .innerText({ timeout: 8000 })
    .catch(() => "");

  for (const re of GDMS_LOGIN_ERROR_PATTERNS) {
    const m = bodyText.match(re);
    if (m) return m[0].trim();
  }

  const alert = page
    .locator('[role="alert"], .alert-danger, .text-danger, [class*="error"], [class*="Error"]')
    .first();
  if (await alert.isVisible({ timeout: 800 }).catch(() => false)) {
    const t = (await alert.innerText().catch(() => "")).trim();
    if (!t) return null;
    for (const re of GDMS_LOGIN_ERROR_PATTERNS) {
      if (re.test(t)) return t;
    }
    if (/password|user\s*id|credential|login/i.test(t) && t.length < 200) return t;
  }

  return null;
}

export function gdmsLoginErrorMessage(detected: string): string {
  return `GDMS rejected login (${detected}). Update User ID and password in Settings for this dealer, then run login again. No OTP was sent.`;
}
