import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import {
  DELETION_REQUEST_STATUSES,
  type DeletionListCursor,
  type DeletionListFilter,
  type DeletionListRow,
  type DeletionSort,
  type DeletionStatusCounts,
} from '../../domain/admin-deletion-list';
import type { AccountDeletionRequestStatus } from '../../domain/account-deletion-request';
import type { AdminDeletionListReader } from '../ports/admin-deletion-list.reader';
import type { MemoryAccountDeletionRequests } from './in-memory-account-deletion';

// In-memory stand-in for the admin Account deletion requests list (super list 25), with the filter,
// sort and cursor of the Prisma reader, over the rows of MemoryAccountDeletionRequests.

function matches(r: DeletionListRow, filter: DeletionListFilter): boolean {
  if (filter.status !== null && r.status !== filter.status) return false;
  if (filter.requestedBy !== null && r.requestedBy !== filter.requestedBy) return false;
  if (filter.cancelReason !== null && r.cancelReason !== filter.cancelReason) return false;
  if (
    filter.requestOrAccountId !== null &&
    r.id !== filter.requestOrAccountId &&
    r.accountId !== filter.requestOrAccountId
  ) {
    return false;
  }
  if (filter.from !== null && Temporal.Instant.compare(r.requestedAt, filter.from) < 0)
    return false;
  if (filter.to !== null && Temporal.Instant.compare(r.requestedAt, filter.to) >= 0) return false;
  if (
    filter.scheduledBefore !== null &&
    Temporal.Instant.compare(r.scheduledFor, filter.scheduledBefore) >= 0
  ) {
    return false;
  }
  return true;
}

function compare(a: DeletionListRow, b: DeletionListRow, sort: DeletionSort): number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  let order: number;
  switch (sort.key) {
    case 'cancelled':
    case 'completed': {
      const field = sort.key === 'cancelled' ? 'cancelledAt' : 'completedAt';
      const x = a[field];
      const y = b[field];
      // Not cancelled or not completed sorts last either way.
      if ((x === null) !== (y === null)) return x === null ? 1 : -1;
      order = x === null || y === null ? 0 : Temporal.Instant.compare(x, y);
      break;
    }
    case 'requested':
      order = Temporal.Instant.compare(a.requestedAt, b.requestedAt);
      break;
    default:
      order = Temporal.Instant.compare(a.scheduledFor, b.scheduledFor);
  }
  if (order === 0) order = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return order * sign;
}

export class MemoryAdminDeletionList implements AdminDeletionListReader {
  /** Every read, so a test can see that nothing was read before a refusal. */
  reads = 0;

  constructor(private readonly requests: MemoryAccountDeletionRequests) {}

  #rows(market: MarketContext): DeletionListRow[] {
    this.reads += 1;
    return [...this.requests.rows.values()]
      .filter((r) => r.market === market.marketId)
      .map((r) => ({
        id: r.id,
        accountId: r.accountId,
        status: r.status,
        requestedBy: r.requestedBy,
        requestedAt: r.requestedAt,
        scheduledFor: r.scheduledFor,
        cancelledAt: r.status === 'cancelled' ? r.closedAt : null,
        cancelReason: r.cancelReason,
        completedAt: r.status === 'completed' ? r.closedAt : null,
      }));
  }

  page(
    market: MarketContext,
    filter: DeletionListFilter,
    sort: DeletionSort,
    offset: number,
    limit: number,
    after: DeletionListCursor | null = null,
  ) {
    const rows = this.#rows(market)
      .filter((r) => matches(r, filter))
      .filter(
        (r) =>
          after === null ||
          Temporal.Instant.compare(r.scheduledFor, after.scheduledFor) > 0 ||
          (Temporal.Instant.compare(r.scheduledFor, after.scheduledFor) === 0 && r.id > after.id),
      )
      .sort((a, b) => compare(a, b, sort));
    return Promise.resolve(rows.slice(offset, offset + limit));
  }

  async idsPage(
    market: MarketContext,
    filter: DeletionListFilter,
    sort: DeletionSort,
    limit: number,
  ) {
    return (await this.page(market, filter, sort, 0, limit)).map((r) => r.id);
  }

  count(market: MarketContext, filter: DeletionListFilter) {
    return Promise.resolve(this.#rows(market).filter((r) => matches(r, filter)).length);
  }

  countByStatus(market: MarketContext): Promise<DeletionStatusCounts> {
    const counts = Object.fromEntries(DELETION_REQUEST_STATUSES.map((s) => [s, 0])) as Record<
      AccountDeletionRequestStatus,
      number
    >;
    for (const r of this.#rows(market)) counts[r.status] += 1;
    return Promise.resolve(counts);
  }

  byIds(market: MarketContext, ids: readonly Id<'AccountDeletionRequest'>[]) {
    return Promise.resolve(this.#rows(market).filter((r) => ids.includes(r.id)));
  }
}
