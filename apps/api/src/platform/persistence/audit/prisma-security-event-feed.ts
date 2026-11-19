import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import {
  MAX_SECURITY_FEED_ROWS,
  type SecurityEventCountQuery,
  type SecurityEventFeed,
  type SecurityEventGroup,
  type SecurityEventGroupQuery,
  type SecurityEventListQuery,
  type SecurityEventRef,
  type SecurityEventSelection,
} from '../../security-events/security-event-feed';
import { auditTx } from './audit-transaction';

const TYPE = /^[a-z][a-z0-9-]*\.[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELD = /^[a-z][a-zA-Z0-9]{0,31}$/;
const CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** A query the feed refuses: a programming error of the rule catalogue, never user input. */
export class SecurityEventFeedQueryError extends Error {
  override readonly name = 'SecurityEventFeedQueryError';
}

function limitOf(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SECURITY_FEED_ROWS) {
    throw new SecurityEventFeedQueryError('limit');
  }
  return limit;
}

/** The checked where of a selection: the Market, the types, the window and the payload codes. */
function whereOf(
  market: MarketContext,
  selection: SecurityEventSelection,
): Record<string, unknown> {
  const { types, since, until, payloadEquals = {} } = selection;
  if (types.length < 1 || types.length > 16 || !types.every((type) => TYPE.test(type))) {
    throw new SecurityEventFeedQueryError('types');
  }
  if (Temporal.Instant.compare(since, until) >= 0) throw new SecurityEventFeedQueryError('window');
  const fields = Object.entries(payloadEquals);
  if (fields.length > 2 || !fields.every(([key, value]) => FIELD.test(key) && CODE.test(value))) {
    throw new SecurityEventFeedQueryError('payloadEquals');
  }
  const where: Record<string, unknown> = {
    marketId: market.marketId,
    tenantId: market.tenantId,
    type: { in: [...types] },
    occurredAt: { gte: toDate(since), lt: toDate(until) },
  };
  if (fields.length > 0) {
    where.AND = fields.map(([key, value]) => ({ payload: { path: [key], equals: value } }));
  }
  return where;
}

/**
 * {@link SecurityEventFeed} on `platform.security_events` (docs/design/data/security.md 3), in the
 * caller's unit through `auditTx`, like the writer and the retention store. Reads use the
 * `(market_id, type, occurred_at)` and `(market_id, target_type, target_id, occurred_at)` indexes
 * of package 1.
 */
export class PrismaSecurityEventFeed implements SecurityEventFeed {
  async groups(
    market: MarketContext,
    query: SecurityEventGroupQuery,
  ): Promise<readonly SecurityEventGroup[]> {
    const where = whereOf(market, query);
    const take = limitOf(query.limit);
    if (!Number.isSafeInteger(query.minCount) || query.minCount < 1) {
      throw new SecurityEventFeedQueryError('minCount');
    }
    const tx = auditTx(market);
    if (query.groupBy === 'market') {
      const all = await tx.securityEvent.aggregate({
        where,
        _count: { _all: true },
        _min: { occurredAt: true },
        _max: { occurredAt: true },
      });
      const count = all._count._all;
      if (count < query.minCount || all._min.occurredAt === null || all._max.occurredAt === null) {
        return [];
      }
      return [
        {
          key: market.marketId,
          count,
          firstAt: toInstant(all._min.occurredAt),
          lastAt: toInstant(all._max.occurredAt),
        },
      ];
    }
    const field = query.groupBy === 'account' ? 'targetId' : 'ip';
    const rows = await tx.securityEvent.groupBy({
      by: [field],
      where: { ...where, [field]: { not: null } },
      _count: { _all: true },
      _min: { occurredAt: true },
      _max: { occurredAt: true },
      having: { [field]: { _count: { gte: query.minCount } } },
      orderBy: [{ _count: { [field]: 'desc' } }, { [field]: 'asc' }],
      take,
    });
    return rows.flatMap((row) => {
      const key = (row as Record<string, unknown>)[field];
      const first = row._min.occurredAt;
      const last = row._max.occurredAt;
      if (typeof key !== 'string' || first === null || last === null) return [];
      return [{ key, count: row._count._all, firstAt: toInstant(first), lastAt: toInstant(last) }];
    });
  }

  async events(
    market: MarketContext,
    query: SecurityEventListQuery,
  ): Promise<readonly SecurityEventRef[]> {
    const rows = await auditTx(market).securityEvent.findMany({
      where: whereOf(market, query),
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: limitOf(query.limit),
      select: { id: true, targetId: true, occurredAt: true },
    });
    return rows.map((row) => ({
      id: row.id,
      targetId: row.targetId,
      occurredAt: toInstant(row.occurredAt),
    }));
  }

  async count(market: MarketContext, query: SecurityEventCountQuery): Promise<number> {
    const where = whereOf(market, query);
    if (query.key !== null) {
      if (query.key.value.length < 1 || query.key.value.length > 64) {
        throw new SecurityEventFeedQueryError('key');
      }
      where[query.key.kind === 'account' ? 'targetId' : 'ip'] = query.key.value;
    }
    return auditTx(market).securityEvent.count({ where });
  }
}
