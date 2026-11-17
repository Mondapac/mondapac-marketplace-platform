import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import {
  firstNameOf,
  type SellerCustomerEntry,
  type SellerCustomerRecord,
  type SellerCustomerSort,
  type SellerCustomerTab,
} from '../../domain/seller-customers';
import type {
  CustomerCodes,
  MonthlyCount,
  SellerCustomerQuery,
  SellerCustomerRepository,
} from '../ports/seller-customers.repository';

interface Row extends SellerCustomerEntry {
  readonly marketId: string;
  readonly code: string;
  readonly exclusive: boolean;
  readonly createdAt: Temporal.Instant;
}

const DAY_MS = 86_400_000;
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);

/**
 * {@link SellerCustomerRepository} in memory, with the first name read from `names` (the
 * directory's display name) as the Prisma adapter reads it from the directory row.
 */
export class InMemorySellerCustomers implements SellerCustomerRepository {
  readonly rows: Row[] = [];
  /** `marketId:accountId` → display name. */
  readonly names = new Map<string, string | null>();

  private record(row: Row): SellerCustomerRecord {
    return {
      sellerId: row.sellerId,
      accountId: row.accountId,
      code: row.code,
      firstName: firstNameOf(this.names.get(`${row.marketId}:${row.accountId}`) ?? null),
      orderCount: row.orderCount,
      firstOrderAt: row.firstOrderAt,
      lastOrderAt: row.lastOrderAt,
      spent:
        row.orderCount === 0 || row.currency === null
          ? null
          : { amount: row.spentMinor, currency: row.currency },
      follower: row.follower,
      followedAt: row.followedAt,
      exclusive: row.exclusive,
      since: row.createdAt,
    };
  }

  codesOfAccount(market: MarketContext, accountId: Id<'Account'>) {
    return Promise.resolve(
      new Map(
        this.rows
          .filter((row) => row.marketId === market.marketId && row.accountId === accountId)
          .map((row) => [row.sellerId, row.code] as const),
      ),
    );
  }

  codeTaken(market: MarketContext, sellerId: Id<'Seller'>, code: string) {
    return Promise.resolve(
      this.rows.some(
        (row) => row.marketId === market.marketId && row.sellerId === sellerId && row.code === code,
      ),
    );
  }

  upsert(market: MarketContext, entry: SellerCustomerEntry, code: string, now: Temporal.Instant) {
    const index = this.rows.findIndex(
      (row) =>
        row.marketId === market.marketId &&
        row.sellerId === entry.sellerId &&
        row.accountId === entry.accountId,
    );
    if (index >= 0) {
      const seen = this.rows[index]!;
      this.rows[index] = { ...seen, ...entry, code: seen.code };
    } else {
      if (
        this.rows.some(
          (row) =>
            row.marketId === market.marketId &&
            row.sellerId === entry.sellerId &&
            row.code === code,
        )
      ) {
        throw new Error('unique violation: (market, seller, customer_code)');
      }
      this.rows.push({
        ...entry,
        marketId: market.marketId,
        code,
        createdAt: now,
      });
    }
    return Promise.resolve();
  }

  removeSellers(
    market: MarketContext,
    accountId: Id<'Account'>,
    sellerIds: readonly Id<'Seller'>[],
  ) {
    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      const row = this.rows[index]!;
      if (
        row.marketId === market.marketId &&
        row.accountId === accountId &&
        sellerIds.includes(row.sellerId)
      ) {
        this.rows.splice(index, 1);
      }
    }
    return Promise.resolve();
  }

  /** The directory's deletion cascades to the rows. */
  removeAccount(market: MarketContext, accountId: Id<'Account'>) {
    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      const row = this.rows[index]!;
      if (row.marketId === market.marketId && row.accountId === accountId)
        this.rows.splice(index, 1);
    }
  }

  private matching(market: MarketContext, query: SellerCustomerQuery): Row[] {
    const s = query.selector;
    return this.rows.filter((row) => {
      if (row.marketId !== market.marketId || row.sellerId !== query.sellerId) return false;
      if (s.view === 'buyers' && row.orderCount === 0) return false;
      if (s.view === 'followers' && !row.follower) return false;
      if (s.view === 'referred' && !row.exclusive) return false;
      if (s.exclusive !== null && row.exclusive !== s.exclusive) return false;
      if (s.codePrefix !== null && !row.code.startsWith(s.codePrefix)) return false;
      if (s.follower !== null && row.follower !== s.follower) return false;
      const last = row.lastOrderAt?.epochMilliseconds ?? null;
      if (s.lastOrderFrom !== null && (last === null || last < dayStart(s.lastOrderFrom)))
        return false;
      if (s.lastOrderTo !== null && (last === null || last >= dayStart(s.lastOrderTo) + DAY_MS))
        return false;
      if (s.ordersMin !== null && row.orderCount < s.ordersMin) return false;
      if (s.ordersMax !== null && row.orderCount > s.ordersMax) return false;
      if (s.spentMin !== null && row.spentMinor < s.spentMin) return false;
      if (s.spentMax !== null && row.spentMinor > s.spentMax) return false;
      return true;
    });
  }

  page(
    market: MarketContext,
    query: SellerCustomerQuery,
    order: { readonly sort: SellerCustomerSort; readonly direction: 'asc' | 'desc' },
    window: { readonly offset: number; readonly limit: number },
  ) {
    const key = (row: Row): number | string => {
      switch (order.sort) {
        case 'last-order':
          return row.lastOrderAt?.epochMilliseconds ?? -1;
        case 'first-order':
          return row.firstOrderAt?.epochMilliseconds ?? -1;
        case 'orders':
          return row.orderCount;
        case 'spent':
          return Number(row.spentMinor);
        case 'followed':
          return row.followedAt?.epochMilliseconds ?? -1;
        case 'code':
          return row.code;
      }
    };
    const sign = order.direction === 'asc' ? 1 : -1;
    const sorted = this.matching(market, query).sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      if (x !== y) return (x < y ? -1 : 1) * sign;
      return (a.accountId < b.accountId ? -1 : 1) * sign;
    });
    return Promise.resolve(
      sorted.slice(window.offset, window.offset + window.limit).map((row) => this.record(row)),
    );
  }

  count(market: MarketContext, query: SellerCustomerQuery) {
    return Promise.resolve(this.matching(market, query).length);
  }

  tabCounts(market: MarketContext, sellerId: Id<'Seller'>) {
    const rows = this.rows.filter(
      (row) => row.marketId === market.marketId && row.sellerId === sellerId,
    );
    return Promise.resolve({
      all: rows.length,
      buyers: rows.filter((row) => row.orderCount > 0).length,
      followers: rows.filter((row) => row.follower).length,
      referred: rows.filter((row) => row.exclusive).length,
    } satisfies Record<SellerCustomerTab, number>);
  }

  findByCode(market: MarketContext, sellerId: Id<'Seller'>, code: string) {
    const row = this.rows.find(
      (candidate) =>
        candidate.marketId === market.marketId &&
        candidate.sellerId === sellerId &&
        candidate.code === code,
    );
    return Promise.resolve(row === undefined ? null : this.record(row));
  }

  async findByCodes(market: MarketContext, sellerId: Id<'Seller'>, codes: readonly string[]) {
    const found: SellerCustomerRecord[] = [];
    for (const code of codes) {
      const record = await this.findByCode(market, sellerId, code);
      if (record !== null) found.push(record);
    }
    return found;
  }

  monthly(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    months: readonly {
      readonly month: string;
      readonly from: Temporal.Instant;
      readonly to: Temporal.Instant;
    }[],
  ): Promise<readonly MonthlyCount[]> {
    const rows = this.rows.filter(
      (row) => row.marketId === market.marketId && row.sellerId === sellerId,
    );
    const within = (at: Temporal.Instant | null, from: Temporal.Instant, to: Temporal.Instant) =>
      at !== null &&
      at.epochMilliseconds >= from.epochMilliseconds &&
      at.epochMilliseconds < to.epochMilliseconds;
    return Promise.resolve(
      months.map(({ month, from, to }) => ({
        month,
        newBuyers: rows.filter((row) => within(row.firstOrderAt, from, to)).length,
        newFollowers: rows.filter((row) => within(row.followedAt, from, to)).length,
      })),
    );
  }
}

/** Codes from a list given in advance, then a counter: lets a test force a collision. */
export class ScriptedCustomerCodes implements CustomerCodes {
  #next = 0;
  constructor(readonly queued: string[] = []) {}

  next(): string {
    const queued = this.queued.shift();
    if (queued !== undefined) return queued;
    this.#next += 1;
    const digits = this.#next.toString().padStart(8, '0');
    return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  }
}
