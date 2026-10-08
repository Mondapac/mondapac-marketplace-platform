import { parseMarketId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../../platform/persistence/prisma.service';
import type { SubjectKeyService } from '../../../../platform/subject-keys/subject-key-service';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type {
  RegisteredSeller,
  SellerAccessRepository,
} from '../../application/ports/seller-access.repository';
import {
  SellerAccess,
  type SellerAccessStateCode,
  type SellerOrigin,
} from '../../domain/seller-access';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const SELECTED = {
  sellerId: true,
  marketId: true,
  origin: true,
  state: true,
  stateChangedAt: true,
  reapplyCount: true,
  registeredAt: true,
  version: true,
  createdAt: true,
} as const;

interface SellerAccessRow {
  readonly sellerId: string;
  readonly marketId: string;
  readonly origin: string;
  readonly state: string;
  readonly stateChangedAt: Date;
  readonly reapplyCount: number;
  readonly registeredAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
}

/** The largest id list one read takes (8.1: `sellerAccessOf` is bounded by its caller). */
const MAX_IDS = 100;

function restore(row: SellerAccessRow): SellerAccess {
  const marketId = parseMarketId(row.marketId);
  if (!marketId.ok) throw new Error('identity.seller_access: a stored row is malformed');
  // The aggregate re-checks origin, state, count and version (SellerAccessInvariantError).
  return SellerAccess.restore({
    sellerId: row.sellerId as Id<'Seller'>,
    marketId: marketId.value,
    origin: row.origin as SellerOrigin,
    state: row.state as SellerAccessStateCode,
    stateChangedAt: toInstant(row.stateChangedAt),
    reapplyCount: row.reapplyCount,
    registeredAt: row.registeredAt === null ? null : toInstant(row.registeredAt),
    version: row.version,
    createdAt: toInstant(row.createdAt),
  });
}

/**
 * {@link SellerAccessRepository} on `identity.seller_access` (data design 3.9). Every statement
 * goes through `PrismaService.tx(market)` with `marketId` at the top level of `where`; writes are
 * single statements, never nested. The seller's data key is created with the row and destroyed
 * before it is deleted (identity design 11.3).
 */
export class PrismaSellerAccessRepository implements SellerAccessRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subjectKeys: SubjectKeyService,
  ) {}

  async findById(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerAccess | null> {
    const row = await this.prisma.tx(market).identitySellerAccess.findFirst({
      where: { marketId: market.marketId, sellerId },
      select: SELECTED,
    });
    return row === null ? null : restore(row);
  }

  async findRegistered(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<SellerAccess[]> {
    if (sellerIds.length === 0) return [];
    if (sellerIds.length > MAX_IDS) throw new RangeError('findRegistered: at most 100 ids');
    const rows = await this.prisma.tx(market).identitySellerAccess.findMany({
      where: {
        marketId: market.marketId,
        sellerId: { in: [...sellerIds] },
        registeredAt: { not: null },
      },
      select: SELECTED,
    });
    return rows.map(restore);
  }

  async listRegistered(
    market: MarketContext,
    after: Id<'Seller'> | null,
    limit: number,
  ): Promise<RegisteredSeller[]> {
    const rows = await this.prisma.tx(market).identitySellerAccess.findMany({
      where: {
        marketId: market.marketId,
        registeredAt: { not: null },
        ...(after === null ? {} : { sellerId: { gt: after } }),
      },
      select: { sellerId: true, origin: true },
      orderBy: { sellerId: 'asc' },
      take: limit,
    });
    return rows.map((row) => {
      if (row.origin !== 'self' && row.origin !== 'invitation') {
        throw new Error('identity.seller_access: a stored origin is malformed');
      }
      return { sellerId: row.sellerId as Id<'Seller'>, origin: row.origin };
    });
  }

  async add(market: MarketContext, access: SellerAccess): Promise<void> {
    const state = access.state;
    await this.subjectKeys.createKey(market, state.sellerId);
    await this.prisma.tx(market).identitySellerAccess.create({
      data: {
        sellerId: state.sellerId,
        marketId: market.marketId,
        tenantId: market.tenantId,
        origin: state.origin,
        state: state.state,
        stateChangedAt: toDate(state.stateChangedAt),
        reapplyCount: state.reapplyCount,
        registeredAt: state.registeredAt === null ? null : toDate(state.registeredAt),
        version: state.version,
        createdAt: toDate(state.createdAt),
      },
      select: { sellerId: true },
    });
  }

  async lockForSession(market: MarketContext, sellerId: Id<'Seller'>): Promise<boolean> {
    // As AccountRepository.lockCredential: an UPDATE that changes no value takes the row's write
    // lock until the unit ends (item H); a concurrent holder makes it wait, under lock_timeout.
    const { count } = await this.prisma.tx(market).identitySellerAccess.updateMany({
      where: { marketId: market.marketId, sellerId },
      data: { version: { increment: 0 } },
    });
    return count === 1;
  }

  async save(market: MarketContext, access: SellerAccess): Promise<void> {
    const state = access.state;
    const expected = access.persistedVersion;
    if (expected === null) throw new Error('save: the seller access was never stored; use add');
    if (state.version === expected) return;
    const { count } = await this.prisma.tx(market).identitySellerAccess.updateMany({
      where: { marketId: market.marketId, sellerId: state.sellerId, version: expected },
      data: {
        state: state.state,
        stateChangedAt: toDate(state.stateChangedAt),
        reapplyCount: state.reapplyCount,
        registeredAt: state.registeredAt === null ? null : toDate(state.registeredAt),
        version: state.version,
      },
    });
    if (count !== 1) throw new StaleAggregateError('seller-access', state.sellerId);
  }

  async removeUnregistered(market: MarketContext, access: SellerAccess): Promise<void> {
    const state = access.state;
    const expected = access.persistedVersion;
    if (expected === null)
      throw new Error('removeUnregistered: the seller access was never stored');
    await this.subjectKeys.destroyKey(market, state.sellerId);
    const { count } = await this.prisma.tx(market).identitySellerAccess.deleteMany({
      where: {
        marketId: market.marketId,
        sellerId: state.sellerId,
        version: expected,
        registeredAt: null,
      },
    });
    if (count !== 1) throw new StaleAggregateError('seller-access', state.sellerId);
  }
}
