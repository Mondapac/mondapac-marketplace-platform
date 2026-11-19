import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type {
  ListCounts,
  ListedSeller,
  ListPageQuery,
  SearchCandidates,
  SellerListRepository,
} from '../../src/modules/sellers/application/ports/seller-list.repository';
import type { FileTab, ListSearch } from '../../src/modules/sellers/domain/seller-list';
import { storeNameKey } from '../../src/modules/sellers/domain/store-name';
import type { SellerListOrder } from '../../src/modules/sellers/domain/seller-super-list';

// A naive model of the admin seller list's reads in memory (sellers data design A3 to A7, and the
// super list's order and OFFSET of list 15): the filters of each file tab, the two orders in both
// directions with the seller id as the tie-break, and the count. The unit spec of list 15 runs on
// it, and the database spec compares the SQL to it.

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Whether a file is in a tab under the query's filters (no cursor, no page). */
export function modelMatches(tab: FileTab, row: ListedSeller, query: ListPageQuery): boolean {
  if (query.onlyIds !== null && !query.onlyIds.includes(row.sellerId)) return false;
  if (query.areaCode !== null && row.serviceAreaCode !== query.areaCode) return false;
  if (tab === 'awaiting-review') {
    return row.pending !== null && (query.kind === null || row.pending.kind === query.kind);
  }
  if (tab === 'incomplete') {
    if (row.hasApprovedRevision || row.draftComplete || row.pending !== null) return false;
    if (!query.outsideArea) return true;
    const open = new Set(query.openAreaCodes);
    return row.hasAddress && (row.serviceAreaCode === null || !open.has(row.serviceAreaCode));
  }
  return true;
}

/**
 * The order of a tab: `queue` is the tab's own (submission, latest change, or the seller id),
 * `name` the store-name key with no name after every name A to Z (NULLS LAST on ASC, PostgreSQL's
 * default) and before them Z to A. The seller id breaks a tie in the same direction.
 */
export function modelCompare(
  tab: FileTab,
  order: SellerListOrder,
): (a: ListedSeller, b: ListedSeller) => number {
  const sign = order.direction === 'asc' ? 1 : -1;
  return (a, b) => {
    let primary = 0;
    if (order.key === 'name') {
      const left = a.storeName === null ? null : storeNameKey(a.storeName);
      const right = b.storeName === null ? null : storeNameKey(b.storeName);
      primary = left === right ? 0 : left === null ? 1 : right === null ? -1 : cmp(left, right);
    } else if (tab === 'awaiting-review') {
      primary = Temporal.Instant.compare(a.pending!.submittedAt, b.pending!.submittedAt);
    } else if (tab === 'incomplete') {
      primary = Temporal.Instant.compare(a.lastChangedAt, b.lastChangedAt);
    }
    return sign * (primary !== 0 ? primary : cmp(a.sellerId, b.sellerId));
  };
}

/** The tab's own order of the older keyset list, where the model needs one without `order`. */
const KEYSET_ORDER: Readonly<Record<FileTab, SellerListOrder>> = {
  'awaiting-review': { key: 'queue', direction: 'asc' },
  incomplete: { key: 'queue', direction: 'desc' },
  all: { key: 'queue', direction: 'desc' },
};

/** One page of a tab as the super list reads it: filters, order, OFFSET and LIMIT. */
export function modelPage(
  tab: FileTab,
  rows: readonly ListedSeller[],
  query: ListPageQuery,
): ListedSeller[] {
  const offset = query.offset ?? 0;
  return rows
    .filter((row) => modelMatches(tab, row, query))
    .sort(modelCompare(tab, query.order ?? KEYSET_ORDER[tab]))
    .slice(offset, offset + query.take);
}

export function modelCount(
  tab: FileTab,
  rows: readonly ListedSeller[],
  query: ListPageQuery,
): number {
  return rows.filter((row) => modelMatches(tab, row, query)).length;
}

/**
 * The list's repository in memory on the model, per Market. The keyset `after` of the older list
 * is not modelled (list 15 never sends it); a read with `order` pages by `offset`.
 */
export class ModelSellerListRepository implements SellerListRepository {
  readonly rows = new Map<string, ListedSeller[]>();
  failing = false;
  /** Every read, by method, to prove what a page asked for. */
  readonly calls: { method: string; query?: ListPageQuery }[] = [];

  add(market: MarketContext, row: ListedSeller): ListedSeller {
    this.rows.set(market.marketId, [...(this.rows.get(market.marketId) ?? []), row]);
    return row;
  }

  private of(market: MarketContext, method: string, query?: ListPageQuery): ListedSeller[] {
    this.calls.push({ method, ...(query === undefined ? {} : { query }) });
    if (this.failing) throw new Error('database down');
    return [...(this.rows.get(market.marketId) ?? [])];
  }

  awaitingReview(market: MarketContext, query: ListPageQuery): Promise<readonly ListedSeller[]> {
    return Promise.resolve(
      modelPage('awaiting-review', this.of(market, 'awaitingReview', query), query),
    );
  }

  incomplete(market: MarketContext, query: ListPageQuery): Promise<readonly ListedSeller[]> {
    return Promise.resolve(modelPage('incomplete', this.of(market, 'incomplete', query), query));
  }

  all(market: MarketContext, query: ListPageQuery): Promise<readonly ListedSeller[]> {
    return Promise.resolve(modelPage('all', this.of(market, 'all', query), query));
  }

  countMatching(market: MarketContext, tab: FileTab, query: ListPageQuery): Promise<number> {
    return Promise.resolve(modelCount(tab, this.of(market, 'countMatching', query), query));
  }

  counts(market: MarketContext): Promise<ListCounts> {
    const rows = this.of(market, 'counts');
    const pending = (kind: string) => rows.filter((row) => row.pending?.kind === kind).length;
    return Promise.resolve({
      awaitingReview: {
        onboarding: pending('onboarding'),
        identityChange: pending('identity-change'),
      },
      incomplete: rows.filter(
        (row) => !row.hasApprovedRevision && !row.draftComplete && row.pending === null,
      ).length,
      all: rows.length,
    });
  }

  searchCandidates(
    market: MarketContext,
    search: ListSearch,
    cap: number,
  ): Promise<SearchCandidates> {
    const found = this.of(market, 'searchCandidates')
      .filter(
        (row) =>
          (row.storeName !== null && storeNameKey(row.storeName).startsWith(search.nameKey)) ||
          (search.slug !== null && row.heldSlug?.startsWith(search.slug) === true),
      )
      .map((row) => row.sellerId);
    return Promise.resolve({ ids: found.slice(0, cap), overflow: found.length > cap });
  }
}
