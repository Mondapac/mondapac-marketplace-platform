import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../../platform/persistence/prisma.service';
import {
  CREDENTIAL_CHANGE_OUTCOMES,
  SIGN_IN_SUCCESS_OUTCOMES,
  type CustomerSignInQuery,
  type CustomerSignInResult,
  type CustomerSignInRow,
  type SignInRecord,
  type SignInRecordRepository,
} from '../../application/ports/sign-in-record.repository';
import { parseDeviceCode } from '../../domain/device';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const KNOWN_OUTCOMES: readonly string[] = [
  ...SIGN_IN_SUCCESS_OUTCOMES,
  ...CREDENTIAL_CHANGE_OUTCOMES,
];

function outcomeOf(result: CustomerSignInResult): object {
  switch (result) {
    case 'success':
      return { outcome: { in: [...SIGN_IN_SUCCESS_OUTCOMES] } };
    case 'credential-change':
      return { outcome: { in: [...CREDENTIAL_CHANGE_OUTCOMES] } };
    default:
      return { outcome: { notIn: [...KNOWN_OUTCOMES] } };
  }
}

/** The where clause of one customer's records: own account, customer population, the range. */
function customerWhere(market: MarketContext, query: CustomerSignInQuery): object {
  return {
    marketId: market.marketId,
    accountId: query.accountId,
    population: 'customer',
    occurredAt: {
      gte: toDate(query.from),
      ...(query.to === null ? {} : { lt: toDate(query.to) }),
    },
    ...(query.results === null ? {} : { OR: query.results.map(outcomeOf) }),
  };
}

/**
 * {@link SignInRecordRepository} on `identity.sign_in_records` (data design 3.6): insert, read
 * the oldest instant, delete by a range of `occurred_at` on `(market_id, occurred_at)`. The
 * application has no `UPDATE` on the table.
 */
export class PrismaSignInRecordRepository implements SignInRecordRepository {
  constructor(private readonly prisma: PrismaService) {}

  async add(market: MarketContext, record: SignInRecord): Promise<void> {
    await this.prisma.tx(market).identitySignInRecord.create({
      data: {
        id: record.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        population: record.population,
        accountId: record.accountId,
        outcome: record.outcome,
        occurredAt: toDate(record.occurredAt),
        origin: record.address,
        sessionId: record.sessionId,
        correlationId: record.correlationId,
        device: record.device,
      },
      select: { id: true },
    });
  }

  async latestSuccessBefore(
    market: MarketContext,
    accountId: Id<'Account'>,
    exceptSession: Id<'Session'>,
  ): Promise<Temporal.Instant | null> {
    const row = await this.prisma.tx(market).identitySignInRecord.findFirst({
      where: {
        marketId: market.marketId,
        accountId,
        outcome: 'signed-in',
        sessionId: { not: exceptSession },
      },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    });
    return row === null ? null : Temporal.Instant.fromEpochMilliseconds(row.occurredAt.getTime());
  }

  async pageOfCustomer(
    market: MarketContext,
    query: CustomerSignInQuery,
    direction: 'asc' | 'desc',
    window: { readonly offset: number; readonly limit: number },
  ): Promise<readonly CustomerSignInRow[]> {
    const rows = await this.prisma.tx(market).identitySignInRecord.findMany({
      where: customerWhere(market, query),
      orderBy: [{ occurredAt: direction }, { id: direction }],
      skip: window.offset,
      take: window.limit,
      // Never the address: the list shows the time, the outcome and the device only.
      select: { id: true, occurredAt: true, outcome: true, device: true },
    });
    return rows.map((row) => ({
      id: row.id as Id<'SignInRecord'>,
      occurredAt: toInstant(row.occurredAt),
      outcome: row.outcome,
      device: parseDeviceCode(row.device),
    }));
  }

  countOfCustomer(market: MarketContext, query: CustomerSignInQuery): Promise<number> {
    return this.prisma.tx(market).identitySignInRecord.count({
      where: customerWhere(market, query),
    });
  }

  async customerAddressOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    recordId: Id<'SignInRecord'>,
    since: Temporal.Instant,
  ): Promise<{ readonly address: string; readonly occurredAt: Temporal.Instant } | null> {
    const row = await this.prisma.tx(market).identitySignInRecord.findFirst({
      where: {
        marketId: market.marketId,
        id: recordId,
        accountId,
        population: 'customer',
        occurredAt: { gte: toDate(since) },
      },
      select: { origin: true, occurredAt: true },
    });
    return row === null ? null : { address: row.origin, occurredAt: toInstant(row.occurredAt) };
  }

  async oldest(market: MarketContext): Promise<Temporal.Instant | null> {
    const row = await this.prisma.tx(market).identitySignInRecord.findFirst({
      where: { marketId: market.marketId },
      orderBy: { occurredAt: 'asc' },
      select: { occurredAt: true },
    });
    return row === null ? null : Temporal.Instant.fromEpochMilliseconds(row.occurredAt.getTime());
  }

  async deleteBetween(
    market: MarketContext,
    from: Temporal.Instant,
    to: Temporal.Instant,
  ): Promise<number> {
    const { count } = await this.prisma.tx(market).identitySignInRecord.deleteMany({
      where: {
        marketId: market.marketId,
        occurredAt: { gte: toDate(from), lt: toDate(to) },
      },
    });
    return count;
  }
}
