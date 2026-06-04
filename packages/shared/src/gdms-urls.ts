/** GDMS login page (User ID / password / OTP). */
export const GDMS_LOGIN_URL =
  "https://ndms.hmil.net/cmm/cmmi/selectLoginMain.dms";

/** GDMS home after successful login (user-confirmed). */
export const GDMS_HOME_URL = "https://ndms.hmil.net/cmm/cmmd/selectHome.dms";

export function resolveGdmsHomeUrl(homeUrl?: string): string {
  return homeUrl?.trim() || GDMS_HOME_URL;
}

export function resolveGdmsLoginUrl(loginUrl?: string): string {
  return loginUrl?.trim() || GDMS_LOGIN_URL;
}
