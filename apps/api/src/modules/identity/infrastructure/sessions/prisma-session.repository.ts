import { parseMarketId, POPULATIONS, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Population } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../../platform/persistence/prisma.service';
import type {
  SessionForAuthentication,
  SessionRepository,
} from '../../application/ports/session.repository';
import type { Session, SessionRevokedReason } from '../../domain/session';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const SELECTED = {
  id: true,
  marketId: true,
  accountId: true,
  population: true,
  sellerId: true,
  transport: true,
  createdAt: true,
  lastSeenAt: true,
  idleTimeoutSeconds: true,
  absoluteExpiresAt: true,
  revokedAt: true,
  revokedReason: true,
} as const;

interface SessionRow {
  readonly id: string;
  readonly marketId: string;
  readonly accountId: string;
  readonly population: string;
  readonly sellerId: string | null;
  readonly transport: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly idleTimeoutSeconds: number;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
}

function restore(row: SessionRow): Session {
  const marketId = parseMarketId(row.marketId);
  if (
    !marketId.ok ||
    !(POPULATIONS as readonly string[]).includes(row.population) ||
    (row.transport !== 'cookie' && row.transport !== 'bearer')
  ) {
    throw new Error('identity.sessions: a stored session is malformed');
  }
  return Object.freeze({
    id: row.id as Id<'Session'>,
    marketId: marketId.value,
    accountId: row.accountId as Id<'Account'>,
    population: row.population as Population,
    sellerId: row.sellerId as Id<'Seller'> | null,
    transport: row.transport,
    createdAt: toInstant(row.createdAt),
    lastSeenAt: toInstant(row.lastSeenAt),
    idleTimeoutSeconds: row.idleTimeoutSeconds,
    absoluteExpiresAt: toInstant(row.absoluteExpiresAt),
    revokedAt: row.revokedAt === null ? null : toInstant(row.revokedAt),
    revokedReason: row.revokedReason,
  });
}

/**
 * {@link SessionRepository} on `identity.sessions` (data design 3.4). Every statement goes
 * through `PrismaService.tx(market)` with `marketId` at the top level of `where`. The per-request
 * read is one call by the unique `(market_id, token_hash)`, with the account's status through
 * the relation (a nested read; nested writes are refused by the guard).
 */
export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async add(market: MarketContext, session: Session, tokenHash: Uint8Array): Promise<void> {
    await this.prisma.tx(market).identitySession.create({
      data: {
        id: session.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        accountId: session.accountId,
        population: session.population,
        sellerId: session.sellerId,
        tokenHash: Uint8Array.from(tokenHash),
        transport: session.transport,
        createdAt: toDate(session.createdAt),
        lastSeenAt: toDate(session.lastSeenAt),
        idleTimeoutSeconds: session.idleTimeoutSeconds,
        absoluteExpiresAt: toDate(session.absoluteExpiresAt),
        revokedAt: session.revokedAt === null ? null : toDate(session.revokedAt),
        revokedReason: session.revokedReason,
      },
      select: { id: true },
    });
  }

  async findForAuthentication(
    market: MarketContext,
    tokenHash: Uint8Array,
  ): Promise<SessionForAuthentication | null> {
    const row = await this.prisma.tx(market).identitySession.findFirst({
      where: { marketId: market.marketId, tokenHash: Uint8Array.from(tokenHash) },
      select: { ...SELECTED, account: { select: { status: true } } },
    });
    if (row === null) return null;
    const status = row.account.status;
    if (status !== 'active' && status !== 'disabled') {
      throw new Error('identity.accounts: a stored account status is malformed');
    }
    return { session: restore(row), accountStatus: status };
  }

  async findById(market: MarketContext, id: Id<'Session'>): Promise<Session | null> {
    const row = await this.prisma.tx(market).identitySession.findFirst({
      where: { marketId: market.marketId, id },
      select: SELECTED,
    });
    return row === null ? null : restore(row);
  }

  async touch(
    market: MarketContext,
    id: Id<'Session'>,
    now: Temporal.Instant,
    lastSeenBefore: Temporal.Instant,
  ): Promise<void> {
    await this.prisma.tx(market).identitySession.updateMany({
      where: {
        marketId: market.marketId,
        id,
        revokedAt: null,
        lastSeenAt: { lte: toDate(lastSeenBefore) },
      },
      data: { lastSeenAt: toDate(now) },
    });
  }

  async revoke(
    market: MarketContext,
    id: Id<'Session'>,
    accountId: Id<'Account'>,
    reason: SessionRevokedReason,
    now: Temporal.Instant,
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).identitySession.updateMany({
      where: { marketId: market.marketId, id, accountId, revokedAt: null },
      data: { revokedAt: toDate(now), revokedReason: reason },
    });
    return count === 1;
  }

  async purgeExpired(market: MarketContext, expiredBefore: Temporal.Instant): Promise<number> {
    const { count } = await this.prisma.tx(market).identitySession.deleteMany({
      where: { marketId: market.marketId, absoluteExpiresAt: { lt: toDate(expiredBefore) } },
    });
    return count;
  }
}
