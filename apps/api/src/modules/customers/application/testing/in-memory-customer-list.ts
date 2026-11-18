import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import {
  ACTIVE_WINDOW_DAYS,
  CUSTOMER_VIEWS,
  NEW_WINDOW_DAYS,
  type CustomerListRow,
  type CustomerSort,
  type CustomerView,
  type SortDirection,
} from '../../domain/customer-list';
import { localDayEnd, localDayStart } from '../../domain/local-day';
import type { CustomerListQuery, CustomerListReader } from '../ports/customer-list.reader';

/** The Customers list reader over an array of rows, one array per Market (for unit tests). */
export class InMemoryCustomerList implements CustomerListReader {
  readonly rowsOf = new Map<string, CustomerListRow[]>();

  add(market: MarketContext, ...rows: CustomerListRow[]): void {
    this.rowsOf.set(market.marketId, [...(this.rowsOf.get(market.marketId) ?? []), ...rows]);
  }

  #all(market: MarketContext): CustomerListRow[] {
    return this.rowsOf.get(market.marketId) ?? [];
  }

  /** `sellerId:accountId` of the follows the "store followed" filter matches. */
  readonly followers = new Set<string>();

  #match(market: MarketContext, query: CustomerListQuery): CustomerListRow[] {
    const { selector, now } = query;
    const day = 24 * 3_600_000;
    return this.#all(market).filter((row) => {
      if (
        selector.followsSellerId != null &&
        !this.followers.has(`${selector.followsSellerId}:${row.accountId}`)
      ) {
        return false;
      }
      switch (selector.view) {
        case 'new':
          if (row.signedUpAt.epochMilliseconds < now.epochMilliseconds - NEW_WINDOW_DAYS * day)
            return false;
          break;
        case 'active':
          if (row.lastOrderAt === null) return false;
          if (row.lastOrderAt.epochMilliseconds < now.epochMilliseconds - ACTIVE_WINDOW_DAYS * day)
            return false;
          break;
        case 'inactive':
          if (row.lastOrderAt === null) return false;
          if (row.lastOrderAt.epochMilliseconds >= now.epochMilliseconds - ACTIVE_WINDOW_DAYS * day)
            return false;
          break;
        case 'never-ordered':
          if (row.orderCount > 0) return false;
          break;
        case 'disabled':
          if (row.status !== 'disabled') return false;
          break;
        case 'pending-deletion':
          return false;
        case 'all':
          break;
      }
      if (selector.accountIds != null && !selector.accountIds.includes(row.accountId)) return false;
      if (selector.status !== null && row.status !== selector.status) return false;
      if (selector.verified !== null && row.emailVerified !== selector.verified) return false;
      if (selector.ordersMin !== null && row.orderCount < selector.ordersMin) return false;
      if (selector.ordersMax !== null && row.orderCount > selector.ordersMax) return false;
      if (selector.spentMin !== null && row.spentMinor < selector.spentMin) return false;
      if (selector.spentMax !== null && row.spentMinor > selector.spentMax) return false;
      if (selector.group !== null && !row.groups.some((group) => group.groupId === selector.group))
        return false;
      const inDays = (at: Temporal.Instant | null, from: string | null, to: string | null) => {
        if (from === null && to === null) return true;
        if (at === null) return false;
        const start = from === null ? null : localDayStart(from, query.zone);
        const end = to === null ? null : localDayEnd(to, query.zone);
        if (start !== null && at.epochMilliseconds < start.epochMilliseconds) return false;
        return end === null || at.epochMilliseconds < end.epochMilliseconds;
      };
      if (!inDays(row.signedUpAt, selector.joinedFrom, selector.joinedTo)) return false;
      if (!inDays(row.lastOrderAt, selector.lastOrderFrom, selector.lastOrderTo)) return false;
      if (selector.text !== null) {
        const text = selector.text.toLowerCase();
        const byEmail = row.email.toLowerCase().startsWith(text);
        const byName = (row.displayName ?? '').toLowerCase().includes(text);
        if (!byEmail && !byName) return false;
      }
      return true;
    });
  }

  rows(
    market: MarketContext,
    query: CustomerListQuery,
    order: { readonly sort: CustomerSort; readonly direction: SortDirection },
    page: { readonly offset: number; readonly limit: number },
  ): Promise<readonly CustomerListRow[]> {
    const key = (row: CustomerListRow): string | number =>
      order.sort === 'joined'
        ? row.signedUpAt.epochMilliseconds
        : order.sort === 'orders'
          ? row.orderCount
          : order.sort === 'spent'
            ? Number(row.spentMinor)
            : order.sort === 'last-order'
              ? (row.lastOrderAt?.epochMilliseconds ?? 0)
              : order.sort === 'name'
                ? (row.displayName ?? '')
                : row.email;
    const sign = order.direction === 'asc' ? 1 : -1;
    const sorted = this.#match(market, query).sort((a, b) =>
      key(a) < key(b) ? -sign : key(a) > key(b) ? sign : 0,
    );
    return Promise.resolve(sorted.slice(page.offset, page.offset + page.limit));
  }

  count(market: MarketContext, query: CustomerListQuery): Promise<number> {
    return Promise.resolve(this.#match(market, query).length);
  }

  viewCounts(
    market: MarketContext,
    now: Temporal.Instant,
  ): Promise<Readonly<Record<CustomerView, number>>> {
    const blank = {
      text: null,
      status: null,
      verified: null,
      joinedFrom: null,
      joinedTo: null,
      lastOrderFrom: null,
      lastOrderTo: null,
      ordersMin: null,
      ordersMax: null,
      spentMin: null,
      spentMax: null,
      group: null,
    } as const;
    return Promise.resolve(
      Object.fromEntries(
        CUSTOMER_VIEWS.map((view) => [
          view,
          this.#match(market, { selector: { ...blank, view }, now, zone: 'UTC' }).length,
        ]),
      ) as Record<CustomerView, number>,
    );
  }

  ids(
    market: MarketContext,
    query: CustomerListQuery,
    limit: number,
  ): Promise<readonly Id<'Account'>[]> {
    return Promise.resolve(
      this.#match(market, query)
        .slice(0, limit)
        .map((row) => row.accountId),
    );
  }

  rowsByIds(
    market: MarketContext,
    ids: readonly Id<'Account'>[],
  ): Promise<readonly CustomerListRow[]> {
    const all = this.#all(market);
    return Promise.resolve(ids.flatMap((id) => all.filter((row) => row.accountId === id)));
  }
}
