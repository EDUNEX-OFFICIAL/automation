"use client";

import { useEffect } from "react";

const CHUNK_RELOAD_KEY = "gdms-web-chunk-reloads";

/**
 * Stale `.next` / missing chunk (`Cannot find module './192.js'`) triggers one or two auto reloads;
 * no infinite loop. Dev always runs after `clean` — this covers edge cases only.
 */
export function ClientBootstrap(): null {
  useEffect(() => {
    const onErr = (e: ErrorEvent): void => {
      const msg = `${e.message ?? ""} ${e.error ?? ""} ${(e.error as Error)?.stack ?? ""}`;
      if (!/(chunk|Cannot find module|\d+\.js)/i.test(msg)) return;
      try {
        const n = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || "0");
        if (n >= 2) return;
        sessionStorage.setItem(CHUNK_RELOAD_KEY, String(n + 1));
        window.location.reload();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("error", onErr);
    return () => window.removeEventListener("error", onErr);
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        sessionStorage.removeItem(CHUNK_RELOAD_KEY);
      } catch {
        /* ignore */
      }
    }, 10_000);
    return () => window.clearTimeout(t);
  }, []);

  return null;
}
