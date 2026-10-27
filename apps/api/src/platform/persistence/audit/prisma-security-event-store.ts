import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { SecurityEventStore } from '../../security-events/security-event-retention';
import { auditTx } from './audit-transaction';

/**
 * The retention store of `platform.security_events` and its archive
 * (docs/design/data/platform.md 13.4). Its statements run in the caller's unit
 * through `auditTx`, like the writer's; the market guard pins every one to the unit's Market.
 * Oldest first on `(occurred_at, id)`, the unique index both tables have.
 */
export class PrismaSecurityEventStore implements SecurityEventStore {
  async archive(
    market: MarketContext,
    before: Temporal.Instant,
    archivedAt: Temporal.Instant,
    limit: number,
  ): Promise<number> {
    const tx = auditTx(market);
    const scope = { marketId: market.marketId, tenantId: market.tenantId };
    const rows = await tx.securityEvent.findMany({
      where: { ...scope, occurredAt: { lt: new Date(before.epochMilliseconds) } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    if (rows.length === 0) return 0;
    const at = new Date(archivedAt.epochMilliseconds);
    // A row a concurrent run archived already is kept as it is (ON CONFLICT DO NOTHING).
    await tx.securityEventArchive.createMany({
      data: rows.map((row) => ({
        id: row.id,
        marketId: row.marketId,
        tenantId: row.tenantId,
        occurredAt: row.occurredAt,
        type: row.type,
        severity: row.severity,
        actorType: row.actorType,
        actorId: row.actorId,
        targetType: row.targetType,
        targetId: row.targetId,
        ip: row.ip,
        payload: row.payload as object,
        correlationId: row.correlationId,
        archivedAt: at,
      })),
      skipDuplicates: true,
    });
    const deleted = await tx.securityEvent.deleteMany({
      where: { ...scope, id: { in: rows.map((row) => row.id) } },
    });
    return deleted.count;
  }

  async purgeArchive(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<number> {
    const tx = auditTx(market);
    const scope = { marketId: market.marketId, tenantId: market.tenantId };
    const rows = await tx.securityEventArchive.findMany({
      where: { ...scope, occurredAt: { lt: new Date(before.epochMilliseconds) } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const deleted = await tx.securityEventArchive.deleteMany({
      where: { ...scope, id: { in: rows.map((row) => row.id) } },
    });
    return deleted.count;
  }
}
