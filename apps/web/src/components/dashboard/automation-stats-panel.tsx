"use client";

import { useMemo, useState } from "react";
import {
  AUTOMATION_STATS_RANGES,
  rangeLabelForChip,
  type AutomationStatsRange,
  type AutomationStatsBreakdownRow,
  type AutomationStatsDealerRow,
} from "@gdms/shared";
import {
  Activity,
  BarChart3,
  CalendarClock,
  LayoutGrid,
  PieChart,
  TrendingUp,
  Users,
  XCircle,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/layout/stat-card";
import { cn } from "@/lib/utils";
import { useAutomationStats } from "@/hooks/use-automation-stats";
import { ChartCard } from "@/components/dashboard/chart-card";
import {
  AutomationTrendChart,
  OperationsMixChart,
  ScPerformanceChart,
} from "@/components/dashboard/automation-stats-charts";

type AutomationStatsPanelProps = {
  token: string | null;
  role: string | undefined;
  dealerId?: string;
  dealers?: { id: string; name: string }[];
  showDealerPicker?: boolean;
  className?: string;
};

function ScBreakdownTable({ rows }: { rows: AutomationStatsBreakdownRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border/80 bg-muted/20 p-6 text-center text-sm text-muted-foreground">
        No Sales Consultants in your team yet.
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2 md:hidden">
        {rows.map((row) => (
          <div
            key={row.userId}
            className="rounded-xl border border-border/80 bg-card/60 px-3 py-3 shadow-sm"
          >
            <p className="truncate text-sm font-semibold text-foreground">{row.displayName}</p>
            <div className="mt-2.5 grid grid-cols-3 gap-2">
              <div className="rounded-lg bg-primary/5 px-2 py-1.5 text-center">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Transfer</p>
                <p
                  className={cn(
                    "mt-0.5 text-base font-semibold tabular-nums",
                    row.enquiryTransfer > 0 ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  {row.enquiryTransfer}
                </p>
              </div>
              <div className="rounded-lg bg-emerald-500/5 px-2 py-1.5 text-center">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Skip</p>
                <p
                  className={cn(
                    "mt-0.5 text-base font-semibold tabular-nums",
                    row.followUpSkip > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
                  )}
                >
                  {row.followUpSkip}
                </p>
              </div>
              <div className="rounded-lg bg-amber-500/5 px-2 py-1.5 text-center">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Lost</p>
                <p
                  className={cn(
                    "mt-0.5 text-base font-semibold tabular-nums",
                    row.lostInquiry > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
                  )}
                >
                  {row.lostInquiry}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="data-table-wrap hidden md:block">
        <table className="data-table min-w-[640px]">
          <thead>
            <tr className="border-b border-border/80 bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-medium">Sales Consultant</th>
              <th className="px-3 py-3 font-medium text-right lg:px-4">
                <span className="inline-flex items-center justify-end gap-1">
                  <Zap className="h-3.5 w-3.5 text-primary" />
                  <span className="hidden lg:inline">Enquiry transfer</span>
                  <span className="lg:hidden">Transfer</span>
                </span>
              </th>
              <th className="px-3 py-3 font-medium text-right lg:px-4">
                <span className="inline-flex items-center justify-end gap-1">
                  <CalendarClock className="h-3.5 w-3.5 text-emerald-500" />
                  <span className="hidden lg:inline">Follow up skip</span>
                  <span className="lg:hidden">Skip</span>
                </span>
              </th>
              <th className="px-3 py-3 font-medium text-right lg:px-4">
                <span className="inline-flex items-center justify-end gap-1">
                  <XCircle className="h-3.5 w-3.5 text-amber-500" />
                  <span className="hidden lg:inline">Lost inquiry</span>
                  <span className="lg:hidden">Lost</span>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.userId}
                className="border-b border-border/50 last:border-0 transition-colors hover:bg-muted/20"
              >
                <td className="max-w-[10rem] truncate px-4 py-3 font-medium text-foreground lg:max-w-none">
                  {row.displayName}
                </td>
                <td className="px-3 py-3 text-right tabular-nums lg:px-4">
                  <span className={row.enquiryTransfer > 0 ? "font-semibold text-primary" : "text-muted-foreground"}>
                    {row.enquiryTransfer}
                  </span>
                </td>
                <td className="px-3 py-3 text-right tabular-nums lg:px-4">
                  <span
                    className={
                      row.followUpSkip > 0
                        ? "font-semibold text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground"
                    }
                  >
                    {row.followUpSkip}
                  </span>
                </td>
                <td className="px-3 py-3 text-right tabular-nums lg:px-4">
                  <span
                    className={
                      row.lostInquiry > 0
                        ? "font-semibold text-amber-600 dark:text-amber-400"
                        : "text-muted-foreground"
                    }
                  >
                    {row.lostInquiry}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function DealerGrid({ rows }: { rows: AutomationStatsDealerRow[] }) {
  const maxTotal = useMemo(() => Math.max(0, ...rows.map((r) => r.total)), [rows]);
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {rows.map((d) => (
        <div
          key={d.dealerId}
          className="relative overflow-hidden rounded-2xl border border-border/70 bg-gradient-to-br from-primary/[0.06] via-card to-card p-5 shadow-card transition-shadow hover:shadow-md"
        >
          <p className="font-semibold text-foreground">{d.dealerName}</p>
          <p className="mt-2 text-3xl font-bold tabular-nums tracking-tight">{d.total}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge variant="secondary" className="gap-1 bg-primary/10 text-primary">
              <Zap className="h-3 w-3" />
              {d.enquiryTransfer}
            </Badge>
            <Badge variant="secondary" className="gap-1 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
              <CalendarClock className="h-3 w-3" />
              {d.followUpSkip}
            </Badge>
            <Badge variant="secondary" className="gap-1 bg-amber-500/10 text-amber-700 dark:text-amber-400">
              <XCircle className="h-3 w-3" />
              {d.lostInquiry}
            </Badge>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${maxTotal > 0 ? (d.total / maxTotal) * 100 : 0}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function KpiSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="h-24 animate-pulse rounded-2xl bg-muted/50 sm:h-28" />
      ))}
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <div className="h-[300px] animate-pulse rounded-2xl bg-muted/50 lg:col-span-3" />
      <div className="h-[300px] animate-pulse rounded-2xl bg-muted/50 lg:col-span-2" />
    </div>
  );
}

export function AutomationStatsPanel({
  token,
  role,
  dealerId: dealerIdProp,
  dealers = [],
  showDealerPicker = false,
  className,
}: AutomationStatsPanelProps) {
  const [range, setRange] = useState<AutomationStatsRange>("all");
  const [selectedDealerId, setSelectedDealerId] = useState(dealerIdProp ?? "");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const effectiveDealerId = showDealerPicker ? selectedDealerId || undefined : dealerIdProp;

  const { data, loading, error } = useAutomationStats({
    token,
    dealerId: effectiveDealerId,
    range,
    customFrom: range === "custom" ? customFrom : undefined,
    customTo: range === "custom" ? customTo : undefined,
  });

  const isSuperAdmin = role === "SUPER_ADMIN";
  const isDealerAdmin = role === "DEALER_ADMIN";
  const isTeamLeader = role === "TEAM_LEADER";
  const isSc = role === "SALES_CONSULTANT";

  const showScChart =
    (isSuperAdmin || isDealerAdmin || isTeamLeader || isSc) &&
    (data?.bySalesConsultant.some((r) => r.total > 0) ?? false);

  return (
    <section
      className={cn(
        "overflow-hidden rounded-2xl border border-border/60 bg-card shadow-card sm:rounded-3xl",
        className,
      )}
    >
      {/* Hero header */}
      <div className="relative border-b border-border/50 bg-gradient-to-br from-primary/[0.08] via-card to-card px-4 py-5 sm:px-6 sm:py-6">
        <div
          className="pointer-events-none absolute -right-8 -top-8 h-40 w-40 rounded-full bg-primary/10 blur-3xl"
          aria-hidden
        />
        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <BarChart3 className="h-5 w-5" strokeWidth={2} />
              </span>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-primary/80">
                  Analytics
                </p>
                <h2 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
                  Automation performance
                </h2>
              </div>
            </div>
            {data?.range ? (
              <p className="mt-2 text-xs text-muted-foreground sm:text-sm">
                {data.range.label}
                {data.range.label !== "All time" ? (
                  <>
                    {" · "}
                    {new Date(data.range.from).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}
                    {" – "}
                    {new Date(data.range.to).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}{" "}
                    IST
                  </>
                ) : null}
              </p>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground sm:text-sm">
                Real-time KPIs across enquiry transfer, follow-up skip &amp; lost inquiry
              </p>
            )}
          </div>

          {data && data.kpis.total > 0 ? (
            <div className="flex shrink-0 items-center gap-3 rounded-2xl border border-border/60 bg-card/80 px-4 py-3 shadow-sm backdrop-blur-sm">
              <Activity className="h-5 w-5 text-primary" />
              <div>
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Total actions
                </p>
                <p className="text-2xl font-bold tabular-nums tracking-tight text-foreground">
                  {data.kpis.total}
                </p>
              </div>
            </div>
          ) : null}
        </div>

        {/* Filters */}
        <div className="relative mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          {showDealerPicker && dealers.length > 0 ? (
            <select
              className="h-9 w-full rounded-xl border border-border/80 bg-card px-3 text-sm shadow-sm sm:w-auto"
              value={selectedDealerId}
              onChange={(e) => setSelectedDealerId(e.target.value)}
            >
              <option value="">All dealers</option>
              {dealers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : null}
          <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5 scrollbar-thin sm:flex-wrap sm:overflow-visible">
            {AUTOMATION_STATS_RANGES.filter((r) => r !== "custom").map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={cn(
                  "shrink-0 rounded-full px-3.5 py-1.5 text-xs font-medium transition-all",
                  range === r
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "bg-background/80 text-muted-foreground ring-1 ring-border/60 hover:text-foreground",
                )}
              >
                {rangeLabelForChip(r)}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setRange("custom")}
              className={cn(
                "shrink-0 rounded-full px-3.5 py-1.5 text-xs font-medium transition-all",
                range === "custom"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-background/80 text-muted-foreground ring-1 ring-border/60 hover:text-foreground",
              )}
            >
              Custom
            </button>
          </div>
        </div>

        {range === "custom" ? (
          <div className="relative mt-3 flex flex-wrap gap-3">
            <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
              From
              <input
                type="datetime-local"
                className="rounded-xl border border-border/80 bg-card px-3 py-2 text-sm text-foreground shadow-sm"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
            </label>
            <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
              To
              <input
                type="datetime-local"
                className="rounded-xl border border-border/80 bg-card px-3 py-2 text-sm text-foreground shadow-sm"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
              />
            </label>
          </div>
        ) : null}
      </div>

      <div className="space-y-5 p-4 sm:space-y-6 sm:p-6">
        {error ? (
          <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {loading && !data ? (
          <>
            <KpiSkeleton />
            <ChartSkeleton />
          </>
        ) : data ? (
          <>
            {/* KPI cards */}
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <StatCard
                label="Enquiry transfer"
                icon={Zap}
                variant="default"
                value={
                  <span className="animate-in fade-in tabular-nums">{data.kpis.enquiryTransfer}</span>
                }
                hint="Enquiries assigned"
                className="rounded-2xl border-border/60 bg-gradient-to-br from-primary/[0.06] to-card"
              />
              <StatCard
                label="Follow up skip"
                icon={CalendarClock}
                variant="success"
                value={
                  <span className="animate-in fade-in tabular-nums">{data.kpis.followUpSkip}</span>
                }
                hint="Follow-ups processed"
                className="rounded-2xl border-border/60 bg-gradient-to-br from-emerald-500/[0.06] to-card"
              />
              <StatCard
                label="Lost inquiry"
                icon={XCircle}
                variant="warning"
                value={
                  <span className="animate-in fade-in tabular-nums">{data.kpis.lostInquiry}</span>
                }
                hint="Lost enquiries closed"
                className="rounded-2xl border-border/60 bg-gradient-to-br from-amber-500/[0.06] to-card"
              />
              <StatCard
                label="Total automation"
                icon={TrendingUp}
                variant="default"
                value={<span className="animate-in fade-in tabular-nums">{data.kpis.total}</span>}
                hint="Combined successful actions"
                className="col-span-2 rounded-2xl border-border/60 lg:col-span-1"
              />
            </div>

            {/* Charts row */}
            {data.kpis.total > 0 ? (
              <>
                <div className="grid gap-4 lg:grid-cols-5">
                  <ChartCard
                    title="Activity trend"
                    description="Daily automation volume by operation"
                    icon={TrendingUp}
                    className="lg:col-span-3"
                  >
                    <AutomationTrendChart data={data.timeSeries ?? []} />
                  </ChartCard>
                  <ChartCard
                    title="Operation mix"
                    description="Share of each automation type"
                    icon={PieChart}
                    className="lg:col-span-2"
                  >
                    <OperationsMixChart
                      enquiryTransfer={data.kpis.enquiryTransfer}
                      followUpSkip={data.kpis.followUpSkip}
                      lostInquiry={data.kpis.lostInquiry}
                    />
                  </ChartCard>
                </div>

                {showScChart ? (
                  <ChartCard
                    title="Consultant performance"
                    description="Top performers by total automation actions"
                    icon={BarChart3}
                  >
                    <ScPerformanceChart rows={data.bySalesConsultant} />
                  </ChartCard>
                ) : null}
              </>
            ) : null}

            {isSuperAdmin && data.byDealer && data.byDealer.length > 0 ? (
              <div className="space-y-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <LayoutGrid className="h-4 w-4 text-primary" />
                  By dealer
                </h3>
                <DealerGrid rows={data.byDealer} />
              </div>
            ) : null}

            {(isSuperAdmin || isDealerAdmin || isTeamLeader) ? (
              <div className="space-y-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Users className="h-4 w-4 text-primary" />
                  {isTeamLeader ? "Your team" : "Sales consultants"}
                </h3>
                <ScBreakdownTable rows={data.bySalesConsultant} />
              </div>
            ) : null}

            {isSc ? (
              <div className="space-y-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  Your counts
                </h3>
                <ScBreakdownTable rows={data.bySalesConsultant} />
              </div>
            ) : null}

            {data.kpis.total === 0 ? (
              <div className="rounded-2xl border border-dashed border-border/80 py-12 text-center">
                <BarChart3 className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
                <p className="text-sm font-medium text-muted-foreground">No automation activity in this period</p>
                <p className="mt-1 text-xs text-muted-foreground/80">
                  Charts and KPIs appear after enquiry transfers, follow-up skips, or lost inquiries complete.
                </p>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
