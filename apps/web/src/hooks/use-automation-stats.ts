"use client";

import { useCallback, useEffect, useState } from "react";
import type { AutomationStatsRange, AutomationStatsResponse } from "@gdms/shared";
import { apiFetch } from "@/lib/api";

type UseAutomationStatsOptions = {
  token: string | null;
  dealerId?: string;
  range: AutomationStatsRange;
  customFrom?: string;
  customTo?: string;
  enabled?: boolean;
};

export function useAutomationStats({
  token,
  dealerId,
  range,
  customFrom,
  customTo,
  enabled = true,
}: UseAutomationStatsOptions) {
  const [data, setData] = useState<AutomationStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    if (!token || !enabled) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ range });
      if (dealerId) params.set("dealerId", dealerId);
      if (range === "custom" && customFrom) params.set("from", new Date(customFrom).toISOString());
      if (range === "custom" && customTo) params.set("to", new Date(customTo).toISOString());
      const res = await apiFetch<AutomationStatsResponse>(
        `/v1/analytics/automation?${params.toString()}`,
        { token },
      );
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load stats");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [token, dealerId, range, customFrom, customTo, enabled]);

  useEffect(() => {
    void fetchStats();
  }, [fetchStats]);

  return { data, loading, error, refetch: fetchStats };
}
