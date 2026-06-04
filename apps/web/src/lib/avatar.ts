import { getApiUrl } from "@/lib/api";

/** Browser-safe avatar src (proxied through Next in production). */
export function resolveAvatarSrc(avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl?.trim()) return null;
  if (avatarUrl.startsWith("http://") || avatarUrl.startsWith("https://") || avatarUrl.startsWith("data:")) {
    return avatarUrl;
  }
  if (avatarUrl.startsWith("/uploads/")) {
    const api = getApiUrl().replace(/\/$/, "");
    if (api.startsWith("http")) return `${api}${avatarUrl}`;
    return `/api-upstream${avatarUrl}`;
  }
  return avatarUrl;
}
