import type { PrismaClient } from "@gdms/database";
import type { Role } from "@gdms/auth";
import { automationStatsScopeForActor } from "@gdms/auth";
import type {
  AutomationStatsBreakdownRow,
  AutomationStatsDealerRow,
  AutomationStatsResponse,
} from "@gdms/shared";
import {
  addIstDays,
  gdmsLabelMatches,
  istDateKey,
  istDateLabel,
  resolveAutomationStatsRange,
  salesConsultantGdmsLabel,
  type AutomationStatsTimeSeriesPoint,
} from "@gdms/shared";

type Actor = { sub: string; role: Role; dealerId: string | null };

type QueryInput = {
  dealerId?: string;
  range: "all" | "today" | "week" | "month" | "custom";
  from?: string;
  to?: string;
};

type ScUser = {
  id: string;
  displayName: string | null;
  username: string;
  avatarUrl: string | null;
  role: string;
  reportsToUserId: string | null;
};

function displayNameForUser(u: { displayName: string | null; username: string }): string {
  return u.displayName?.trim() || u.username;
}

function buildWhere(
  actor: Actor,
  input: QueryInput,
  window: { from: Date; to: Date },
): Record<string, unknown> {
  const scope = automationStatsScopeForActor(actor);
  const where: Record<string, unknown> = {
    occurredAt: { gte: window.from, lte: window.to },
  };

  if (input.dealerId) {
    where.dealerId = input.dealerId;
  } else if (scope.dealerId) {
    where.dealerId = scope.dealerId;
  }

  if (scope.teamLeaderScopeUserId) {
    where.OR = [
      { teamLeaderUserId: scope.teamLeaderScopeUserId },
      { startedByUserId: scope.teamLeaderScopeUserId },
      {
        teamLeaderUserId: null,
        startedByUserId: scope.teamLeaderScopeUserId,
      },
    ];
  } else if (scope.teamLeaderUserId) {
    where.teamLeaderUserId = scope.teamLeaderUserId;
  }

  if (scope.orSelf) {
    where.OR = [
      { salesConsultantUserId: scope.orSelf.salesConsultantUserId },
      { startedByUserId: scope.orSelf.startedByUserId },
    ];
  }

  return where;
}

async function loadScopeSalesConsultants(
  prisma: PrismaClient,
  actor: Actor,
  dealerId: string | undefined,
): Promise<ScUser[]> {
  const baseSelect = {
    id: true,
    displayName: true,
    username: true,
    avatarUrl: true,
    role: true,
    reportsToUserId: true,
  } as const;

  if (actor.role === "SALES_CONSULTANT") {
    const u = await prisma.user.findUnique({
      where: { id: actor.sub },
      select: baseSelect,
    });
    return u?.role === "SALES_CONSULTANT" ? [u as ScUser] : [];
  }

  if (actor.role === "TEAM_LEADER") {
    return prisma.user.findMany({
      where: {
        reportsToUserId: actor.sub,
        role: "SALES_CONSULTANT",
        isActive: true,
        ...(dealerId ? { dealerId } : {}),
      },
      select: baseSelect,
      orderBy: [{ displayName: "asc" }, { username: "asc" }],
    });
  }

  if (actor.role === "DEALER_ADMIN" && dealerId) {
    return prisma.user.findMany({
      where: { dealerId, role: "SALES_CONSULTANT", isActive: true },
      select: baseSelect,
      orderBy: [{ displayName: "asc" }, { username: "asc" }],
    });
  }

  if (actor.role === "SUPER_ADMIN" && dealerId) {
    return prisma.user.findMany({
      where: { dealerId, role: "SALES_CONSULTANT", isActive: true },
      select: baseSelect,
      orderBy: [{ displayName: "asc" }, { username: "asc" }],
    });
  }

  return [];
}

function resolveEventToScId(
  event: {
    salesConsultantUserId: string | null;
    salesConsultantLabel: string;
  },
  scopeScs: ScUser[],
  scById: Map<string, ScUser>,
): string | null {
  if (event.salesConsultantUserId) {
    const u = scById.get(event.salesConsultantUserId);
    if (u?.role === "SALES_CONSULTANT") return u.id;
  }
  for (const sc of scopeScs) {
    if (gdmsLabelMatches(salesConsultantGdmsLabel(sc), event.salesConsultantLabel)) {
      return sc.id;
    }
  }
  return null;
}

function buildScBreakdown(
  scopeScs: ScUser[],
  events: Array<{
    operation: string;
    salesConsultantUserId: string | null;
    salesConsultantLabel: string;
  }>,
): AutomationStatsBreakdownRow[] {
  const scById = new Map(scopeScs.map((sc) => [sc.id, sc]));
  const counts = new Map<string, { enquiryTransfer: number; followUpSkip: number; lostInquiry: number }>();
  for (const sc of scopeScs) {
    counts.set(sc.id, { enquiryTransfer: 0, followUpSkip: 0, lostInquiry: 0 });
  }

  for (const e of events) {
    const scId = resolveEventToScId(e, scopeScs, scById);
    if (!scId) continue;
    const cur = counts.get(scId)!;
    if (e.operation === "enquiry_transfer") cur.enquiryTransfer += 1;
    else if (e.operation === "follow_up_skip") cur.followUpSkip += 1;
    else if (e.operation === "lost_inquiry") cur.lostInquiry += 1;
  }

  return scopeScs
    .map((sc) => {
      const c = counts.get(sc.id)!;
      return {
        userId: sc.id,
        displayName: displayNameForUser(sc),
        username: sc.username,
        avatarUrl: sc.avatarUrl,
        enquiryTransfer: c.enquiryTransfer,
        followUpSkip: c.followUpSkip,
        lostInquiry: c.lostInquiry,
        total: c.enquiryTransfer + c.followUpSkip + c.lostInquiry,
      };
    })
    .sort((a, b) => b.total - a.total || a.displayName.localeCompare(b.displayName));
}

const MAX_DAILY_POINTS = 45;

function buildTimeSeries(
  events: Array<{ operation: string; occurredAt: Date }>,
  window: { from: Date; to: Date },
): AutomationStatsTimeSeriesPoint[] {
  const buckets = new Map<
    string,
    { enquiryTransfer: number; followUpSkip: number; lostInquiry: number }
  >();

  for (const e of events) {
    const key = istDateKey(e.occurredAt);
    const cur = buckets.get(key) ?? { enquiryTransfer: 0, followUpSkip: 0, lostInquiry: 0 };
    if (e.operation === "enquiry_transfer") cur.enquiryTransfer += 1;
    else if (e.operation === "follow_up_skip") cur.followUpSkip += 1;
    else if (e.operation === "lost_inquiry") cur.lostInquiry += 1;
    buckets.set(key, cur);
  }

  const fromKey = istDateKey(window.from);
  const toKey = istDateKey(window.to);
  const daily: AutomationStatsTimeSeriesPoint[] = [];
  let cursor = fromKey;
  let guard = 0;
  while (cursor <= toKey && guard++ < 400) {
    const counts = buckets.get(cursor) ?? { enquiryTransfer: 0, followUpSkip: 0, lostInquiry: 0 };
    daily.push({
      date: cursor,
      label: istDateLabel(cursor),
      enquiryTransfer: counts.enquiryTransfer,
      followUpSkip: counts.followUpSkip,
      lostInquiry: counts.lostInquiry,
      total: counts.enquiryTransfer + counts.followUpSkip + counts.lostInquiry,
    });
    if (cursor === toKey) break;
    cursor = addIstDays(cursor, 1);
  }

  if (daily.length <= MAX_DAILY_POINTS) return daily;

  const weekly: AutomationStatsTimeSeriesPoint[] = [];
  for (let i = 0; i < daily.length; i += 7) {
    const slice = daily.slice(i, i + 7);
    if (slice.length === 0) continue;
    const agg = slice.reduce(
      (acc, p) => ({
        enquiryTransfer: acc.enquiryTransfer + p.enquiryTransfer,
        followUpSkip: acc.followUpSkip + p.followUpSkip,
        lostInquiry: acc.lostInquiry + p.lostInquiry,
        total: acc.total + p.total,
      }),
      { enquiryTransfer: 0, followUpSkip: 0, lostInquiry: 0, total: 0 },
    );
    weekly.push({
      date: slice[0]!.date,
      label: `${slice[0]!.label} – ${slice[slice.length - 1]!.label}`,
      ...agg,
    });
  }
  return weekly;
}

export async function queryAutomationStats(
  prisma: PrismaClient,
  actor: Actor,
  input: QueryInput,
): Promise<AutomationStatsResponse> {
  const window = resolveAutomationStatsRange({
    range: input.range,
    from: input.from,
    to: input.to,
  });

  const effectiveDealerId = input.dealerId ?? actor.dealerId ?? undefined;
  const where = buildWhere(actor, input, window);

  if (input.range === "all") {
    const earliest = await prisma.automationStatEvent.findFirst({
      where: where as never,
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
    });
    if (earliest) {
      window.from = earliest.occurredAt;
    }
  }

  const events = await prisma.automationStatEvent.findMany({
    where: where as never,
    select: {
      operation: true,
      occurredAt: true,
      dealerId: true,
      teamLeaderUserId: true,
      salesConsultantUserId: true,
      salesConsultantLabel: true,
      startedByUserId: true,
    },
  });

  let enquiryTransfer = 0;
  let followUpSkip = 0;
  let lostInquiry = 0;
  for (const e of events) {
    if (e.operation === "enquiry_transfer") enquiryTransfer += 1;
    else if (e.operation === "follow_up_skip") followUpSkip += 1;
    else if (e.operation === "lost_inquiry") lostInquiry += 1;
  }

  const scopeScs = await loadScopeSalesConsultants(prisma, actor, effectiveDealerId);
  const bySalesConsultant = buildScBreakdown(scopeScs, events);

  const tlCounts = new Map<string, { enquiryTransfer: number; followUpSkip: number; lostInquiry: number }>();
  const dealerCounts = new Map<string, { enquiryTransfer: number; followUpSkip: number; lostInquiry: number }>();

  for (const e of events) {
    if (e.teamLeaderUserId) {
      const cur = tlCounts.get(e.teamLeaderUserId) ?? {
        enquiryTransfer: 0,
        followUpSkip: 0,
        lostInquiry: 0,
      };
      if (e.operation === "enquiry_transfer") cur.enquiryTransfer += 1;
      else if (e.operation === "follow_up_skip") cur.followUpSkip += 1;
      else if (e.operation === "lost_inquiry") cur.lostInquiry += 1;
      tlCounts.set(e.teamLeaderUserId, cur);
    }

    const dCur = dealerCounts.get(e.dealerId) ?? {
      enquiryTransfer: 0,
      followUpSkip: 0,
      lostInquiry: 0,
    };
    if (e.operation === "enquiry_transfer") dCur.enquiryTransfer += 1;
    else if (e.operation === "follow_up_skip") dCur.followUpSkip += 1;
    else if (e.operation === "lost_inquiry") dCur.lostInquiry += 1;
    dealerCounts.set(e.dealerId, dCur);
  }

  const tlUserIds = [...tlCounts.keys()];
  const tlUsers =
    tlUserIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: tlUserIds } },
          select: {
            id: true,
            displayName: true,
            username: true,
            avatarUrl: true,
            role: true,
          },
        })
      : [];
  const tlUserById = new Map(tlUsers.map((u) => [u.id, u]));

  const byTeamLeader: AutomationStatsBreakdownRow[] = [...tlCounts.entries()]
    .map(([userId, counts]) => {
      const u = tlUserById.get(userId);
      const total = counts.enquiryTransfer + counts.followUpSkip + counts.lostInquiry;
      return {
        userId,
        displayName: u ? displayNameForUser(u) : userId,
        username: u?.username ?? "",
        avatarUrl: u?.avatarUrl ?? null,
        enquiryTransfer: counts.enquiryTransfer,
        followUpSkip: counts.followUpSkip,
        lostInquiry: counts.lostInquiry,
        total,
      };
    })
    .sort((a, b) => b.total - a.total);

  let byDealer: AutomationStatsDealerRow[] | undefined;
  if (actor.role === "SUPER_ADMIN") {
    const dealerIds = [...dealerCounts.keys()];
    const dealers =
      dealerIds.length > 0
        ? await prisma.dealer.findMany({
            where: { id: { in: dealerIds } },
            select: { id: true, name: true },
          })
        : [];
    const dealerNameById = new Map(dealers.map((d) => [d.id, d.name]));
    byDealer = dealerIds
      .map((dealerId) => {
        const counts = dealerCounts.get(dealerId)!;
        return {
          dealerId,
          dealerName: dealerNameById.get(dealerId) ?? dealerId,
          enquiryTransfer: counts.enquiryTransfer,
          followUpSkip: counts.followUpSkip,
          lostInquiry: counts.lostInquiry,
          total: counts.enquiryTransfer + counts.followUpSkip + counts.lostInquiry,
        };
      })
      .sort((a, b) => b.total - a.total);
  }

  return {
    range: {
      label: window.label,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    },
    kpis: {
      enquiryTransfer,
      followUpSkip,
      lostInquiry,
      total: enquiryTransfer + followUpSkip + lostInquiry,
    },
    timeSeries: events.length > 0 ? buildTimeSeries(events, window) : [],
    byTeamLeader,
    bySalesConsultant,
    ...(byDealer ? { byDealer } : {}),
  };
}
