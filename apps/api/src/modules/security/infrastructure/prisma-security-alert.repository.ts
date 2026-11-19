import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AlertDeliveryRecord,
  AlertListQuery,
  DigestRunRecord,
  NewAlert,
  SecurityAlertRepository,
} from '../application/ports/security-alert.repository';
import type { AlertResolution, AlertState, SecurityAlert } from '../domain/alert';
import { type AlertListFilter, type AlertSort, type AlertViewCounts } from '../domain/alert-list';
import type { DeliveryChannel, DeliveryOutcome } from '../domain/delivery';
import type { AlertKeyType } from '../domain/rules';
import { SEVERITIES, type SecuritySeverity } from '../domain/severity';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const toOptionalInstant = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);

interface AlertRow {
  readonly id: string;
  readonly rule: string;
  readonly severity: string;
  readonly state: string;
  readonly keyType: string;
  readonly keyValue: string;
  readonly eventCount: number;
  readonly firstEventAt: Date;
  readonly lastEventAt: Date;
  readonly openedAt: Date;
  readonly notifyStep: number;
  readonly nextNotifyAt: Date | null;
  readonly acknowledgedAt: Date | null;
  readonly acknowledgedBy: string | null;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly resolution: string | null;
  readonly resolutionNote: string | null;
  readonly version: number;
}

const toAlert = (row: AlertRow): SecurityAlert => ({
  id: row.id,
  rule: row.rule,
  severity: row.severity as SecuritySeverity,
  state: row.state as AlertState,
  keyType: row.keyType as AlertKeyType,
  keyValue: row.keyValue,
  eventCount: row.eventCount,
  firstEventAt: toInstant(row.firstEventAt),
  lastEventAt: toInstant(row.lastEventAt),
  openedAt: toInstant(row.openedAt),
  notifyStep: row.notifyStep,
  nextNotifyAt: toOptionalInstant(row.nextNotifyAt),
  acknowledgedAt: toOptionalInstant(row.acknowledgedAt),
  acknowledgedBy: row.acknowledgedBy,
  resolvedAt: toOptionalInstant(row.resolvedAt),
  resolvedBy: row.resolvedBy,
  resolution: row.resolution as AlertResolution | null,
  resolutionNote: row.resolutionNote,
  version: row.version,
});

const LIVE: readonly AlertState[] = ['open', 'acknowledged'];

/** {@link SecurityAlertRepository} on the `security` schema, scoped by the unit's Market. */
const LIVE_STATES = ['open', 'acknowledged'];

/** The `where` of the alert list for a filter (the twin of `alertMatches`). */
function listWhere(market: MarketContext, filter: AlertListFilter) {
  const where: Record<string, unknown> = { marketId: market.marketId };
  switch (filter.view) {
    case 'all':
      break;
    case 'open':
    case 'acknowledged':
    case 'resolved':
      where.state = filter.view;
      break;
    case 'critical':
      where.state = { in: LIVE_STATES };
      where.severity = 's1';
      break;
  }
  if (filter.severities.length > 0) {
    where.severity =
      filter.view === 'critical'
        ? filter.severities.includes('s1')
          ? 's1'
          : { in: [] }
        : { in: [...filter.severities] };
  }
  if (filter.rule !== null) where.rule = filter.rule;
  if (filter.keyType !== null) where.keyType = filter.keyType;
  if (filter.keyValue !== null) where.keyValue = filter.keyValue;
  if (filter.from !== null || filter.to !== null) {
    where.openedAt = {
      ...(filter.from === null ? {} : { gte: toDate(filter.from) }),
      ...(filter.to === null ? {} : { lt: toDate(filter.to) }),
    };
  }
  if (filter.minEvents !== null) where.eventCount = { gte: filter.minEvents };
  return where;
}

export class PrismaSecurityAlertRepository implements SecurityAlertRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findLive(
    market: MarketContext,
    rule: string,
    keyType: AlertKeyType,
    keyValue: string,
  ): Promise<SecurityAlert | null> {
    const row = await this.prisma.tx(market).securityAlert.findFirst({
      where: { marketId: market.marketId, rule, keyType, keyValue, state: { in: [...LIVE] } },
    });
    return row === null ? null : toAlert(row);
  }

  async lastResolvedAt(
    market: MarketContext,
    rule: string,
    keyType: AlertKeyType,
    keyValue: string,
  ): Promise<Temporal.Instant | null> {
    const row = await this.prisma.tx(market).securityAlert.findFirst({
      where: { marketId: market.marketId, rule, keyType, keyValue, state: 'resolved' },
      orderBy: { resolvedAt: 'desc' },
      select: { resolvedAt: true },
    });
    return row === null ? null : toOptionalInstant(row.resolvedAt);
  }

  async open(market: MarketContext, alert: NewAlert): Promise<boolean> {
    // ON CONFLICT DO NOTHING: the partial unique index keeps one live alert per rule and key.
    const created = await this.prisma.tx(market).securityAlert.createMany({
      data: [
        {
          id: alert.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          rule: alert.rule,
          severity: alert.severity,
          state: 'open',
          keyType: alert.keyType,
          keyValue: alert.keyValue,
          eventCount: alert.eventCount,
          firstEventAt: toDate(alert.firstEventAt),
          lastEventAt: toDate(alert.lastEventAt),
          openedAt: toDate(alert.openedAt),
          notifyStep: 0,
          nextNotifyAt: alert.nextNotifyAt === null ? null : toDate(alert.nextNotifyAt),
          version: 1,
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }

  async touch(
    market: MarketContext,
    alert: SecurityAlert,
    match: { readonly eventCount: number; readonly lastEventAt: Temporal.Instant },
  ): Promise<boolean> {
    const eventCount = Math.max(alert.eventCount, match.eventCount);
    const lastEventAt =
      Temporal.Instant.compare(match.lastEventAt, alert.lastEventAt) > 0
        ? match.lastEventAt
        : alert.lastEventAt;
    if (eventCount === alert.eventCount && lastEventAt.equals(alert.lastEventAt)) return false;
    const updated = await this.prisma.tx(market).securityAlert.updateMany({
      where: {
        marketId: market.marketId,
        id: alert.id,
        version: alert.version,
        state: { in: [...LIVE] },
      },
      data: { eventCount, lastEventAt: toDate(lastEventAt), version: alert.version + 1 },
    });
    return updated.count === 1;
  }

  async saveTransition(market: MarketContext, alert: SecurityAlert): Promise<boolean> {
    const updated = await this.prisma.tx(market).securityAlert.updateMany({
      where: { marketId: market.marketId, id: alert.id, version: alert.version - 1 },
      data: {
        state: alert.state,
        nextNotifyAt: alert.nextNotifyAt === null ? null : toDate(alert.nextNotifyAt),
        acknowledgedAt: alert.acknowledgedAt === null ? null : toDate(alert.acknowledgedAt),
        acknowledgedBy: alert.acknowledgedBy,
        resolvedAt: alert.resolvedAt === null ? null : toDate(alert.resolvedAt),
        resolvedBy: alert.resolvedBy,
        resolution: alert.resolution,
        resolutionNote: alert.resolutionNote,
        version: alert.version,
      },
    });
    return updated.count === 1;
  }

  async claimStep(
    market: MarketContext,
    alert: SecurityAlert,
    next: { readonly notifyStep: number; readonly nextNotifyAt: Temporal.Instant | null },
  ): Promise<boolean> {
    const updated = await this.prisma.tx(market).securityAlert.updateMany({
      where: {
        marketId: market.marketId,
        id: alert.id,
        version: alert.version,
        state: 'open',
        notifyStep: alert.notifyStep,
      },
      data: {
        notifyStep: next.notifyStep,
        nextNotifyAt: next.nextNotifyAt === null ? null : toDate(next.nextNotifyAt),
        version: alert.version + 1,
      },
    });
    return updated.count === 1;
  }

  async due(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly SecurityAlert[]> {
    const rows = await this.prisma.tx(market).securityAlert.findMany({
      where: { marketId: market.marketId, state: 'open', nextNotifyAt: { lte: toDate(now) } },
      orderBy: [{ nextNotifyAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toAlert);
  }

  async get(market: MarketContext, id: string): Promise<SecurityAlert | null> {
    const row = await this.prisma
      .tx(market)
      .securityAlert.findFirst({ where: { marketId: market.marketId, id } });
    return row === null ? null : toAlert(row);
  }

  async list(market: MarketContext, query: AlertListQuery): Promise<readonly SecurityAlert[]> {
    const after = query.after;
    const where: Record<string, unknown> = {
      marketId: market.marketId,
      state: { in: [...query.states] },
      severity: { in: [...query.severities] },
    };
    if (after !== null) {
      const openedAt = toDate(after.openedAt);
      where.OR = [
        { severity: { gt: after.severity } },
        { severity: after.severity, openedAt: { lt: openedAt } },
        { severity: after.severity, openedAt, id: { lt: after.id } },
      ];
    }
    const rows = await this.prisma.tx(market).securityAlert.findMany({
      where,
      orderBy: [{ severity: 'asc' }, { openedAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
    });
    return rows.map(toAlert);
  }

  async queryList(
    market: MarketContext,
    filter: AlertListFilter,
    sort: AlertSort,
    offset: number,
    limit: number,
  ): Promise<readonly SecurityAlert[]> {
    const d = sort.direction;
    // `severity` sorts the text s1..s4; ties by the newest opened, like the older list.
    const orderBy =
      sort.key === 'severity'
        ? [{ severity: d }, { openedAt: 'desc' as const }, { id: 'desc' as const }]
        : sort.key === 'opened'
          ? [{ openedAt: d }, { id: d }]
          : sort.key === 'last-event'
            ? [{ lastEventAt: d }, { id: d }]
            : [{ eventCount: d }, { id: d }];
    const rows = await this.prisma.tx(market).securityAlert.findMany({
      where: listWhere(market, filter),
      orderBy,
      skip: offset,
      take: limit,
    });
    return rows.map(toAlert);
  }

  countListWhere(market: MarketContext, filter: AlertListFilter): Promise<number> {
    return this.prisma.tx(market).securityAlert.count({ where: listWhere(market, filter) });
  }

  async viewCounts(market: MarketContext): Promise<AlertViewCounts> {
    // One grouped read; every view is a sum of its (state, severity) groups.
    const rows = await this.prisma.tx(market).securityAlert.groupBy({
      by: ['state', 'severity'],
      where: { marketId: market.marketId },
      _count: { _all: true },
    });
    const counts = { all: 0, open: 0, acknowledged: 0, critical: 0, resolved: 0 };
    for (const row of rows) {
      const n = row._count._all;
      counts.all += n;
      if (row.state === 'open') counts.open += n;
      else if (row.state === 'acknowledged') counts.acknowledged += n;
      else if (row.state === 'resolved') counts.resolved += n;
      if (row.severity === 's1' && row.state !== 'resolved') counts.critical += n;
    }
    return counts;
  }

  async findByIds(
    market: MarketContext,
    ids: readonly string[],
  ): Promise<readonly SecurityAlert[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.tx(market).securityAlert.findMany({
      where: { marketId: market.marketId, id: { in: [...ids] } },
    });
    return rows.map(toAlert);
  }

  async liveCounts(market: MarketContext): Promise<Readonly<Record<SecuritySeverity, number>>> {
    const rows = await this.prisma.tx(market).securityAlert.groupBy({
      by: ['severity'],
      where: { marketId: market.marketId, state: { in: [...LIVE] } },
      _count: { _all: true },
    });
    const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<
      SecuritySeverity,
      number
    >;
    for (const row of rows) {
      if ((SEVERITIES as readonly string[]).includes(row.severity)) {
        counts[row.severity as SecuritySeverity] = row._count._all;
      }
    }
    return counts;
  }

  async countOpened(
    market: MarketContext,
    severity: SecuritySeverity,
    since: Temporal.Instant,
    until: Temporal.Instant,
  ): Promise<{ readonly opened: number; readonly live: number }> {
    const tx = this.prisma.tx(market);
    const opened = await tx.securityAlert.count({
      where: {
        marketId: market.marketId,
        severity,
        openedAt: { gte: toDate(since), lt: toDate(until) },
      },
    });
    const live = await tx.securityAlert.count({
      where: { marketId: market.marketId, severity, state: { in: [...LIVE] } },
    });
    return { opened, live };
  }

  async recordDeliveries(
    market: MarketContext,
    rows: readonly AlertDeliveryRecord[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.prisma.tx(market).securityAlertDelivery.createMany({
      data: rows.map((row) => ({
        id: row.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        alertId: row.alertId,
        step: row.step,
        recipient: row.recipient,
        channel: row.channel,
        outcome: row.outcome,
        at: toDate(row.at),
      })),
    });
  }

  async deliveriesOf(
    market: MarketContext,
    alertId: string,
  ): Promise<readonly AlertDeliveryRecord[]> {
    const rows = await this.prisma.tx(market).securityAlertDelivery.findMany({
      where: { marketId: market.marketId, alertId },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    return rows.map((row) => ({
      id: row.id,
      alertId: row.alertId,
      step: row.step,
      recipient: row.recipient,
      channel: row.channel as DeliveryChannel,
      outcome: row.outcome as DeliveryOutcome,
      at: toInstant(row.at),
    }));
  }

  async recordDigest(market: MarketContext, run: DigestRunRecord): Promise<boolean> {
    const created = await this.prisma.tx(market).securityDigestRun.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          kind: run.kind,
          period: run.period,
          alerts: run.alerts,
          outcome: run.outcome,
          sentAt: toDate(run.sentAt),
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }

  async hasDigest(
    market: MarketContext,
    kind: 'daily' | 'weekly',
    period: string,
  ): Promise<boolean> {
    const row = await this.prisma.tx(market).securityDigestRun.findFirst({
      where: { marketId: market.marketId, kind, period },
      select: { period: true },
    });
    return row !== null;
  }

  async recordEvaluatorRun(
    market: MarketContext,
    run: { readonly finishedAt: Temporal.Instant; readonly opened: number },
  ): Promise<void> {
    // An update, then an insert of the first run: the Market guard refuses an upsert by the key.
    const tx = this.prisma.tx(market);
    const data = { finishedAt: toDate(run.finishedAt), opened: run.opened };
    const updated = await tx.securityEvaluatorRun.updateMany({
      where: { marketId: market.marketId },
      data,
    });
    if (updated.count > 0) return;
    await tx.securityEvaluatorRun.createMany({
      data: [{ marketId: market.marketId, tenantId: market.tenantId, ...data }],
      skipDuplicates: true,
    });
  }

  async lastEvaluatorRun(
    market: MarketContext,
  ): Promise<{ readonly finishedAt: Temporal.Instant; readonly opened: number } | null> {
    const row = await this.prisma.tx(market).securityEvaluatorRun.findFirst({
      where: { marketId: market.marketId },
    });
    return row === null ? null : { finishedAt: toInstant(row.finishedAt), opened: row.opened };
  }
}
