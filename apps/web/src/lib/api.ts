import { useAuthStore } from "@/stores/auth-store";
import { toUserMessage } from "@/lib/user-messages";

const rawApi = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Windows: `localhost` often resolves to `::1` first; ::1 and 127 can hit different listeners on the same numeric port */
function ipv4LoopbackForSocket(hostname: string): string {
  if (hostname === "localhost" || hostname === "::1") return "127.0.0.1";
  return hostname;
}

function normalizeAbsoluteSocketOrigin(uri: string): string {
  try {
    const u = new URL(uri);
    u.hostname = ipv4LoopbackForSocket(u.hostname);
    return u.toString().replace(/\/$/, "");
  } catch {
    return uri;
  }
}

/** Base URL for HTTP API (supports same-origin `/api-upstream` when proxied via next.config.mjs). */
export function getApiUrl(): string {
  if (!rawApi.startsWith("/")) return normalizeAbsoluteSocketOrigin(rawApi);
  if (typeof window !== "undefined") return `${window.location.origin}${rawApi}`;
  const port = process.env.NEXT_PUBLIC_DEV_WEB_PORT ?? "3000";
  return `http://127.0.0.1:${port}${rawApi}`;
}

/** Socket.IO entry when using a proxied REST base (`/…`) or overrides. Client-only callers should invoke from `useEffect`. */
export function getSocketIoSettings(): { uri: string; path?: string } {
  const sock = process.env.NEXT_PUBLIC_SOCKET_URL;
  if (sock) {
    if (sock.startsWith("/"))
      return {
        uri:
          typeof window !== "undefined" ? window.location.origin : `http://127.0.0.1:${process.env.NEXT_PUBLIC_DEV_WEB_PORT ?? "3000"}`,
        path: `${sock.replace(/\/$/, "")}/socket.io`,
      };
    return { uri: normalizeAbsoluteSocketOrigin(sock), path: "/socket.io" };
  }
  if (rawApi.startsWith("/"))
    return {
      uri: typeof window !== "undefined" ? window.location.origin : `http://127.0.0.1:${process.env.NEXT_PUBLIC_DEV_WEB_PORT ?? "3000"}`,
      path: `${rawApi.replace(/\/$/, "")}/socket.io`,
    };
  return { uri: normalizeAbsoluteSocketOrigin(rawApi), path: "/socket.io" };
}

/** Quick check that the API process is up (used before OTP submit). */
export async function checkApiHealth(): Promise<void> {
  try {
    const res = await fetch(`${getApiUrl()}/health`, { credentials: "include" });
    if (!res.ok) throw new Error(`health ${res.status}`);
  } catch {
    throw new Error("API is not running.");
  }
}

/** Try cookie refresh; returns new access token or null. */
async function tryRefreshAccessToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const res = await fetch(`${getApiUrl()}/v1/auth/refresh`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { accessToken: string };
  const u = useAuthStore.getState().user;
  if (u) useAuthStore.getState().setAuth(data.accessToken, u);
  else useAuthStore.getState().setAccessToken(data.accessToken);
  return data.accessToken;
}

export class ApiHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiHttpError";
    this.status = status;
    this.body = body;
  }
}

export async function apiFetch<T>(
  path: string,
  opts: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token: initialToken, ...rest } = opts;

  const doFetch = async (authToken: string | undefined): Promise<Response> => {
    const headers = new Headers(rest.headers);
    const hasBody = rest.body !== undefined && rest.body !== null && rest.body !== "";
    if (hasBody && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (authToken) headers.set("Authorization", `Bearer ${authToken}`);
    return fetch(`${getApiUrl()}${path}`, { ...rest, headers, credentials: "include" });
  };

  let res: Response;
  try {
    res = await doFetch(initialToken);
  } catch (e) {
    throw new Error(toUserMessage(e, "network"));
  }

  const canSilentRefresh =
    res.status === 401 &&
    initialToken &&
    typeof window !== "undefined" &&
    !path.startsWith("/v1/auth/refresh") &&
    !path.startsWith("/v1/auth/login") &&
    !path.startsWith("/v1/auth/register");

  if (canSilentRefresh) {
    const newTok = await tryRefreshAccessToken();
    if (newTok) res = await doFetch(newTok);
  }

  if (!res.ok) {
    const text = await res.text();
    const context = path.startsWith("/v1/auth/") ? "auth" : "generic";
    let body: unknown = text;
    try {
      body = text ? (JSON.parse(text) as unknown) : text;
    } catch {
      /* plain text */
    }
    throw new ApiHttpError(toUserMessage(text || res.statusText, context), res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
