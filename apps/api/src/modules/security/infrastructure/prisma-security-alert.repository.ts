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
