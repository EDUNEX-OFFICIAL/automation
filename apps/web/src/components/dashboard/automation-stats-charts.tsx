"use client";

import { useMemo } from "react";
import type { AutomationStatsBreakdownRow, AutomationStatsTimeSeriesPoint } from "@gdms/shared";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART_COLORS, OPERATION_LABELS } from "@/lib/chart-colors";
import { cn } from "@/lib/utils";

type TrendChartProps = {
  data: AutomationStatsTimeSeriesPoint[];
  className?: string;
};

type MixChartProps = {
  enquiryTransfer: number;
  followUpSkip: number;
  lostInquiry: number;
  className?: string;
};

type ScBarChartProps = {
  rows: AutomationStatsBreakdownRow[];
  className?: string;
  maxRows?: number;
};

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border/80 bg-card/95 px-3 py-2 text-xs shadow-lg backdrop-blur-sm">
      {label ? <p className="mb-1.5 font-medium text-foreground">{label}</p> : null}
      <ul className="space-y-1">
        {payload.map((entry) => (
          <li key={entry.name} className="flex items-center justify-between gap-4 tabular-nums">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ background: entry.color }} />
              {entry.name}
            </span>
            <span className="font-semibold text-foreground">{entry.value ?? 0}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="flex h-[220px] flex-col items-center justify-center rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 text-center sm:h-[260px]">
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

export function AutomationTrendChart({ data, className }: TrendChartProps) {
  const hasActivity = data.some((d) => d.total > 0);
  const tickInterval = useMemo(() => {
    if (data.length <= 7) return 0;
    if (data.length <= 14) return 1;
    return Math.ceil(data.length / 6) - 1;
  }, [data.length]);

  if (!hasActivity) {
    return <ChartEmpty message="No activity in this period — trend will appear after runs complete." />;
  }

  return (
    <div className={cn("h-[220px] w-full sm:h-[280px]", className)}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 4, left: -16, bottom: 0 }}>
          <defs>
            <linearGradient id="gradEt" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.enquiryTransfer} stopOpacity={0.35} />
              <stop offset="100%" stopColor={CHART_COLORS.enquiryTransfer} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="gradFus" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.followUpSkip} stopOpacity={0.3} />
              <stop offset="100%" stopColor={CHART_COLORS.followUpSkip} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="gradLi" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.lostInquiry} stopOpacity={0.3} />
              <stop offset="100%" stopColor={CHART_COLORS.lostInquiry} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            tickLine={false}
            axisLine={false}
            interval={tickInterval}
            minTickGap={12}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            tickLine={false}
            axisLine={false}
            width={32}
          />
          <Tooltip content={<ChartTooltip />} />
          <Legend
            verticalAlign="bottom"
            height={36}
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
            formatter={(value) => (
              <span className="text-muted-foreground">{value}</span>
            )}
          />
          <Area
            type="monotone"
            dataKey="enquiryTransfer"
            name={OPERATION_LABELS.enquiryTransfer}
            stackId="1"
            stroke={CHART_COLORS.enquiryTransfer}
            fill="url(#gradEt)"
            strokeWidth={2}
          />
          <Area
            type="monotone"
            dataKey="followUpSkip"
            name={OPERATION_LABELS.followUpSkip}
            stackId="1"
            stroke={CHART_COLORS.followUpSkip}
            fill="url(#gradFus)"
            strokeWidth={2}
          />
          <Area
            type="monotone"
            dataKey="lostInquiry"
            name={OPERATION_LABELS.lostInquiry}
            stackId="1"
            stroke={CHART_COLORS.lostInquiry}
            fill="url(#gradLi)"
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function OperationsMixChart({
  enquiryTransfer,
  followUpSkip,
  lostInquiry,
  className,
}: MixChartProps) {
  const total = enquiryTransfer + followUpSkip + lostInquiry;
  const slices = useMemo(
    () =>
      [
        { name: OPERATION_LABELS.enquiryTransfer, value: enquiryTransfer, color: CHART_COLORS.enquiryTransfer },
        { name: OPERATION_LABELS.followUpSkip, value: followUpSkip, color: CHART_COLORS.followUpSkip },
        { name: OPERATION_LABELS.lostInquiry, value: lostInquiry, color: CHART_COLORS.lostInquiry },
      ].filter((s) => s.value > 0),
    [enquiryTransfer, followUpSkip, lostInquiry],
  );

  if (total === 0) {
    return <ChartEmpty message="Operation mix will show once automation runs succeed." />;
  }

  return (
    <div className={cn("relative h-[220px] w-full sm:h-[280px]", className)}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={slices}
            cx="50%"
            cy="46%"
            innerRadius="52%"
            outerRadius="72%"
            paddingAngle={3}
            dataKey="value"
            nameKey="name"
            strokeWidth={0}
          >
            {slices.map((entry) => (
              <Cell key={entry.name} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip />} />
          <Legend
            verticalAlign="bottom"
            height={36}
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: 11 }}
            formatter={(value) => <span className="text-muted-foreground">{value}</span>}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute left-1/2 top-[46%] -translate-x-1/2 -translate-y-1/2 text-center">
        <p className="text-2xl font-bold tabular-nums tracking-tight text-foreground sm:text-3xl">{total}</p>
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Total</p>
      </div>
    </div>
  );
}

export function ScPerformanceChart({ rows, className, maxRows = 8 }: ScBarChartProps) {
  const chartData = useMemo(() => {
    return [...rows]
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, maxRows)
      .map((r) => ({
        name: r.displayName.split(" ").slice(0, 2).join(" "),
        fullName: r.displayName,
        enquiryTransfer: r.enquiryTransfer,
        followUpSkip: r.followUpSkip,
        lostInquiry: r.lostInquiry,
        total: r.total,
      }));
  }, [rows, maxRows]);

  if (chartData.length === 0) {
    return <ChartEmpty message="Consultant performance chart appears when SCs have activity." />;
  }

  const height = Math.max(220, chartData.length * 44 + 48);

  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={chartData}
          layout="vertical"
          margin={{ top: 4, right: 8, left: 4, bottom: 4 }}
          barCategoryGap="18%"
        >
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} horizontal={false} />
          <XAxis type="number" allowDecimals={false} hide />
          <YAxis
            type="category"
            dataKey="name"
            width={72}
            tick={{ fontSize: 11, fill: "hsl(var(--foreground))" }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]?.payload as (typeof chartData)[0];
              return (
                <div className="rounded-lg border border-border/80 bg-card/95 px-3 py-2 text-xs shadow-lg backdrop-blur-sm">
                  <p className="mb-1.5 font-medium text-foreground">{row.fullName}</p>
                  <ul className="space-y-1 tabular-nums">
                    <li className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Transfer</span>
                      <span className="font-semibold">{row.enquiryTransfer}</span>
                    </li>
                    <li className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Skip</span>
                      <span className="font-semibold">{row.followUpSkip}</span>
                    </li>
                    <li className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Lost</span>
                      <span className="font-semibold">{row.lostInquiry}</span>
                    </li>
                  </ul>
                </div>
              );
            }}
          />
          <Bar dataKey="enquiryTransfer" stackId="sc" fill={CHART_COLORS.enquiryTransfer} radius={[0, 0, 0, 0]} />
          <Bar dataKey="followUpSkip" stackId="sc" fill={CHART_COLORS.followUpSkip} />
          <Bar dataKey="lostInquiry" stackId="sc" fill={CHART_COLORS.lostInquiry} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
