import { money, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  CartRepository,
  IdleAccountCart,
  IdleCartCursor,
} from '../application/ports/cart.repository';
import type { CartLine, CartOwner, CartState } from '../domain/cart';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface LineRow {
  readonly id: string;
  readonly offerId: string;
  readonly variantId: string;
  readonly quantity: number;
  readonly priceAtAddAmount: bigint;
  readonly priceAtAddCurrency: string;
  readonly addedAt: Date;
}

interface CartRow {
  readonly id: string;
  readonly marketId: string;
  readonly accountId: string | null;
  readonly guestTokenHash: Uint8Array | null;
  readonly status: string;
  readonly lastChangedAt: Date;
  readonly mergedIntoCartId: string | null;
  readonly mergedAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly lines: readonly LineRow[];
}

const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

function toLine(row: LineRow): CartLine {
  return {
    id: row.id as Id<'CartLine'>,
    offerId: row.offerId as Id<'Offer'>,
    variantId: row.variantId as Id<'Variant'>,
    quantity: row.quantity,
    priceAtAdd: money(row.priceAtAddAmount, row.priceAtAddCurrency),
    addedAt: toInstant(row.addedAt),
  };
}

function toCart(row: CartRow): CartState {
  const owner: CartOwner =
    row.accountId !== null
      ? { kind: 'account', accountId: row.accountId as Id<'Account'> }
      : { kind: 'guest', tokenHash: hexOf(row.guestTokenHash!) };
  return {
    id: row.id as Id<'Cart'>,
    marketId: row.marketId as MarketId,
    owner,
    status: row.status as CartState['status'],
    lastChangedAt: toInstant(row.lastChangedAt),
    mergedIntoCartId: row.mergedIntoCartId as Id<'Cart'> | null,
    mergedAt: row.mergedAt === null ? null : toInstant(row.mergedAt),
    version: row.version,
    createdAt: toInstant(row.createdAt),
    lines: [...row.lines]
      .sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime() || a.id.localeCompare(b.id))
      .map(toLine),
  };
}

const ownerColumns = (owner: CartOwner) =>
  owner.kind === 'account'
    ? { accountId: owner.accountId, guestTokenHash: null }
    : { accountId: null, guestTokenHash: Buffer.from(owner.tokenHash, 'hex') };

const lineData = (line: CartLine) => ({
  offerId: line.offerId,
  variantId: line.variantId,
  quantity: line.quantity,
  priceAtAddAmount: line.priceAtAdd.amount,
  priceAtAddCurrency: line.priceAtAdd.currency,
  addedAt: toDate(line.addedAt),
});

/** A unique violation (Prisma P2002), however the driver adapter wraps it. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'P2002';
}

/**
 * {@link CartRepository} on `cart.carts` and `cart.cart_lines`, through the Market-scoped client
 * with `marketId` at the top level of every `where`.
 */
export class PrismaCartRepository implements CartRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findActiveByAccount(market: MarketContext, accountId: Id<'Account'>) {
    const row = await this.prisma.tx(market).cartCart.findFirst({
      where: { marketId: market.marketId, accountId, status: 'active' },
      include: { lines: true },
    });
    return row === null ? null : toCart(row);
  }

  async findByGuestHash(market: MarketContext, tokenHash: string) {
    const row = await this.prisma.tx(market).cartCart.findFirst({
      where: { marketId: market.marketId, guestTokenHash: Buffer.from(tokenHash, 'hex') },
      include: { lines: true },
    });
    return row === null ? null : toCart(row);
  }

  async insert(market: MarketContext, cart: CartState): Promise<'inserted' | 'duplicate'> {
    const tx = this.prisma.tx(market);
    const created = await tx.cartCart.createMany({
      data: [
        {
          id: cart.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          ...ownerColumns(cart.owner),
          status: cart.status,
          lastChangedAt: toDate(cart.lastChangedAt),
          mergedIntoCartId: cart.mergedIntoCartId,
          mergedAt: cart.mergedAt === null ? null : toDate(cart.mergedAt),
          version: cart.version,
          createdAt: toDate(cart.createdAt),
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 0) return 'duplicate';
    if (cart.lines.length > 0) {
      await tx.cartLine.createMany({
        data: cart.lines.map((line) => ({
          id: line.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          cartId: cart.id,
          ...lineData(line),
        })),
      });
    }
    return 'inserted';
  }

  async save(market: MarketContext, cart: CartState): Promise<'saved' | 'stale'> {
    const tx = this.prisma.tx(market);
    let updated: { count: number };
    try {
      updated = await tx.cartCart.updateMany({
        where: { marketId: market.marketId, id: cart.id, version: cart.version },
        data: {
          ...ownerColumns(cart.owner),
          status: cart.status,
          lastChangedAt: toDate(cart.lastChangedAt),
          mergedIntoCartId: cart.mergedIntoCartId,
          mergedAt: cart.mergedAt === null ? null : toDate(cart.mergedAt),
          // Every change clears the order mark; `markOrdered` sets it again after an order.
          orderedAt: null,
          version: cart.version + 1,
        },
      });
    } catch (error) {
      // The rare transfer race (cart design 18, L1): the account got an active cart between the
      // read and this write, so the unique index "one active cart per account" refuses the
      // transfer. The caller answers `conflict.stale`; the client retries.
      if (isUniqueViolation(error)) return 'stale';
      throw error;
    }
    if (updated.count === 0) return 'stale';
    const existing = await tx.cartLine.findMany({
      where: { marketId: market.marketId, cartId: cart.id },
      select: { id: true },
    });
    const known = new Set(existing.map((row) => row.id));
    const kept = new Set(cart.lines.map((line) => line.id as string));
    const removed = [...known].filter((id) => !kept.has(id));
    if (removed.length > 0) {
      await tx.cartLine.deleteMany({
        where: { marketId: market.marketId, cartId: cart.id, id: { in: removed } },
      });
    }
    const fresh = cart.lines.filter((line) => !known.has(line.id));
    if (fresh.length > 0) {
      await tx.cartLine.createMany({
        data: fresh.map((line) => ({
          id: line.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          cartId: cart.id,
          ...lineData(line),
        })),
      });
    }
    for (const line of cart.lines.filter((l) => known.has(l.id))) {
      await tx.cartLine.updateMany({
        where: { marketId: market.marketId, cartId: cart.id, id: line.id },
        data: {
          quantity: line.quantity,
          priceAtAddAmount: line.priceAtAdd.amount,
          priceAtAddCurrency: line.priceAtAdd.currency,
          addedAt: toDate(line.addedAt),
        },
      });
    }
    return 'saved';
  }

  async markOrdered(market: MarketContext, cartId: Id<'Cart'>, at: Temporal.Instant) {
    await this.prisma.tx(market).cartCart.updateMany({
      // Only the cart as the order's save just left it: a cart changed since is not marked.
      where: { marketId: market.marketId, id: cartId, lastChangedAt: toDate(at) },
      data: { orderedAt: toDate(at) },
    });
  }

  async idleAccountCarts(
    market: MarketContext,
    query: {
      readonly changedAfter: Temporal.Instant;
      readonly changedAtOrBefore: Temporal.Instant;
      readonly after: IdleCartCursor | null;
      readonly limit: number;
      readonly accountIds?: readonly Id<'Account'>[];
    },
  ): Promise<readonly IdleAccountCart[]> {
    const tx = this.prisma.tx(market);
    const after = query.after;
    const rows = await tx.cartCart.findMany({
      where: {
        marketId: market.marketId,
        accountId: query.accountIds === undefined ? { not: null } : { in: [...query.accountIds] },
        status: 'active',
        lastChangedAt: { gt: toDate(query.changedAfter), lte: toDate(query.changedAtOrBefore) },
        lines: { some: {} },
        // Not left as a paid order left it (the buyer's next change clears the mark).
        orderedAt: null,
        AND: [
          ...(after === null
            ? []
            : [
                {
                  OR: [
                    { lastChangedAt: { gt: toDate(after.lastChangedAt) } },
                    { lastChangedAt: toDate(after.lastChangedAt), id: { gt: after.cartId } },
                  ],
                },
              ]),
        ],
      },
      orderBy: [{ lastChangedAt: 'asc' }, { id: 'asc' }],
      take: query.limit,
      select: {
        id: true,
        accountId: true,
        lastChangedAt: true,
      },
    });
    if (rows.length === 0) return [];
    // The line counts of this page only, on the lines' (market, cart, ...) unique index.
    const counts = await tx.cartLine.groupBy({
      by: ['cartId'],
      where: { marketId: market.marketId, cartId: { in: rows.map((row) => row.id) } },
      _count: { _all: true },
    });
    const countOf = new Map(counts.map((row) => [row.cartId, row._count._all]));
    return rows.map((row) => ({
      cartId: row.id as Id<'Cart'>,
      accountId: row.accountId as Id<'Account'>,
      lastChangedAt: toInstant(row.lastChangedAt),
      lineCount: countOf.get(row.id) ?? 0,
    }));
  }

  async purgeInactive(
    market: MarketContext,
    guestBefore: Temporal.Instant,
    accountBefore: Temporal.Instant,
    limit: number,
  ): Promise<number> {
    const tx = this.prisma.tx(market);
    // A guest cart has a token hash, in any status; an account cart has an account id.
    const expired = {
      marketId: market.marketId,
      OR: [
        { guestTokenHash: { not: null }, lastChangedAt: { lte: toDate(guestBefore) } },
        { accountId: { not: null }, lastChangedAt: { lte: toDate(accountBefore) } },
      ],
    };
    const rows = await tx.cartCart.findMany({
      where: expired,
      orderBy: [{ lastChangedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const { count } = await tx.cartCart.deleteMany({
      where: { ...expired, id: { in: rows.map((row) => row.id) } },
    });
    return count;
  }
}
