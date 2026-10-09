import { money, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { CartRepository } from '../application/ports/cart.repository';
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
    const updated = await tx.cartCart.updateMany({
      where: { marketId: market.marketId, id: cart.id, version: cart.version },
      data: {
        ...ownerColumns(cart.owner),
        status: cart.status,
        lastChangedAt: toDate(cart.lastChangedAt),
        mergedIntoCartId: cart.mergedIntoCartId,
        mergedAt: cart.mergedAt === null ? null : toDate(cart.mergedAt),
        version: cart.version + 1,
      },
    });
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
}
