import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  AccountListCursor,
  ConnectedAccountListReader,
} from '../../src/modules/payments/application/ports/connected-account-list.reader';
import type { ConnectedAccountRecord } from '../../src/modules/payments/application/ports/connected-account-store';
import type { SellerNames } from '../../src/modules/payments/application/ports/seller-names';
import {
  ACCOUNT_STATUSES,
  type AccountStatus,
} from '../../src/modules/payments/domain/connected-account';
import type {
  AccountListFilter,
  AccountSort,
} from '../../src/modules/payments/domain/connected-account-list';
import type { MemoryAccountStore } from './payments-fakes';

// In-memory stand-ins for the admin Seller accounts list (super list 22): the reader works over
// MemoryAccountStore's rows with the filter, sort and cursor of the Prisma reader.

const after = (a: Temporal.Instant | null, b: Temporal.Instant) =>
  a !== null && Temporal.Instant.compare(a, b) > 0;

export function matchesAccount(
  row: ConnectedAccountRecord,
  filter: AccountListFilter,
  withStatus = true,
): boolean {
  if (withStatus && filter.status !== null && row.status !== filter.status) return false;
  const ready = row.status === 'enabled' && !after(row.coolingOffUntil, filter.now);
  if (filter.ready !== null && ready !== filter.ready) return false;
  if (filter.requirements === 'past-due' && !row.requirementsPastDue) return false;
  if (filter.requirements === 'due' && row.requirementsDue === 0) return false;
  if (filter.requirements === 'none' && (row.requirementsDue > 0 || row.requirementsPastDue)) {
    return false;
  }
  if (filter.waiting === 'cooling-off' && !after(row.coolingOffUntil, filter.now)) return false;
  if (filter.waiting === 'paused' && !after(row.payoutsPausedUntil, filter.now)) return false;
  if (filter.sellerId !== null && row.sellerId !== filter.sellerId) return false;
  if (filter.sellerIds !== null && !filter.sellerIds.includes(row.sellerId)) return false;
  if (filter.from !== null && Temporal.Instant.compare(row.createdAt, filter.from) < 0)
    return false;
  if (filter.to !== null && Temporal.Instant.compare(row.createdAt, filter.to) >= 0) return false;
  return true;
}

const byInstant = (a: Temporal.Instant | null, b: Temporal.Instant | null, nullsLow: boolean) => {
  if (a === null && b === null) return 0;
  if (a === null) return nullsLow ? -1 : 1;
  if (b === null) return nullsLow ? 1 : -1;
  return Temporal.Instant.compare(a, b);
};

export function compareAccounts(
  a: ConnectedAccountRecord,
  b: ConnectedAccountRecord,
  sort: AccountSort,
): number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  let order: number;
  switch (sort.key) {
    case 'last-read':
      // Never read is last when newest first and first when oldest first (Prisma's nulls option).
      order = byInstant(a.lastReadAt, b.lastReadAt, true);
      break;
    case 'requirements':
      order =
        Number(a.requirementsPastDue) - Number(b.requirementsPastDue) ||
        a.requirementsDue - b.requirementsDue;
      break;
    default:
      order = Temporal.Instant.compare(a.createdAt, b.createdAt);
  }
  if (order === 0) order = a.sellerId < b.sellerId ? -1 : a.sellerId > b.sellerId ? 1 : 0;
  return order * sign;
}

export class MemoryAccountList implements ConnectedAccountListReader {
  /** Every read, so a test can see that nothing was read before a refusal. */
  reads = 0;

  constructor(private readonly store: MemoryAccountStore) {}

  #rows(market: MarketContext, filter: AccountListFilter, sort: AccountSort, withStatus = true) {
    this.reads += 1;
    return [...this.store.rows.values()]
      .filter((row) => row.market === market.marketId && matchesAccount(row, filter, withStatus))
      .sort((a, b) => compareAccounts(a, b, sort));
  }

  page(
    market: MarketContext,
    filter: AccountListFilter,
    sort: AccountSort,
    offset: number,
    limit: number,
    cursor: AccountListCursor | null = null,
  ) {
    if (cursor === null) {
      return Promise.resolve(this.#rows(market, filter, sort).slice(offset, offset + limit));
    }
    const rows = this.#rows(market, filter, { key: 'created', direction: 'desc' }).filter(
      (row) =>
        Temporal.Instant.compare(row.createdAt, cursor.createdAt) < 0 ||
        (Temporal.Instant.compare(row.createdAt, cursor.createdAt) === 0 &&
          row.sellerId < cursor.sellerId),
    );
    return Promise.resolve(rows.slice(offset, offset + limit));
  }

  count(market: MarketContext, filter: AccountListFilter) {
    return Promise.resolve(
      this.#rows(market, filter, { key: 'created', direction: 'desc' }).length,
    );
  }

  countByStatus(market: MarketContext, filter: AccountListFilter) {
    const counts = Object.fromEntries(ACCOUNT_STATUSES.map((s) => [s, 0])) as Record<
      AccountStatus,
      number
    >;
    for (const row of this.#rows(market, filter, { key: 'created', direction: 'desc' }, false)) {
      counts[row.status] += 1;
    }
    return Promise.resolve(counts);
  }

  ids(market: MarketContext, filter: AccountListFilter, sort: AccountSort, limit: number) {
    return Promise.resolve(
      this.#rows(market, filter, sort)
        .slice(0, limit)
        .map((row) => row.sellerId),
    );
  }

  byIds(market: MarketContext, sellerIds: readonly string[]) {
    this.reads += 1;
    return Promise.resolve(
      [...this.store.rows.values()].filter(
        (row) => row.market === market.marketId && sellerIds.includes(row.sellerId),
      ),
    );
  }
}

/** Store names by seller id; `search` answers by substring, `failing` makes every call fail. */
export class FakeAccountSellerNames implements SellerNames {
  readonly names = new Map<string, string>();
  failing = false;
  capped = false;

  storeNames(_context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    if (this.failing) return Promise.resolve('unavailable' as const);
    return Promise.resolve(
      new Map(sellerIds.map((id) => [id as string, this.names.get(id) ?? null] as const)),
    );
  }

  storesMatching(_context: CallContext, term: string) {
    if (this.failing) return Promise.reject(new Error('sellers down'));
    const sellerIds = [...this.names.entries()]
      .filter(([, name]) => name.toLowerCase().includes(term.toLowerCase()))
      .map(([id]) => id);
    return Promise.resolve({ sellerIds, capped: this.capped });
  }
}
