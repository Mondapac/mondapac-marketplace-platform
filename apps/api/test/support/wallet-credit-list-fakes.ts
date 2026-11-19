import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { AdminCreditRecord } from '../../src/modules/wallet/application/ports/admin-credit.repository';
import type { AdminCreditListReader } from '../../src/modules/wallet/application/ports/admin-credit-list.reader';
import {
  ADMIN_CREDIT_STATUSES,
  type AdminCreditStatus,
} from '../../src/modules/wallet/domain/admin-credit';
import type {
  CreditListCursor,
  CreditListFilter,
  CreditSort,
  CreditStatusCounts,
} from '../../src/modules/wallet/domain/admin-credit-list';

// In-memory stand-in for the admin Credit requests list (super list 24), with the filter, sort
// and cursor of the Prisma reader. `rowsOf` gives the Market's own requests.

function matches(r: AdminCreditRecord, filter: CreditListFilter): boolean {
  if (filter.statuses !== null && !filter.statuses.includes(r.status)) return false;
  if (filter.status !== null && r.status !== filter.status) return false;
  if (filter.reason !== null && r.reasonCode !== filter.reason) return false;
  if (filter.approvalReason !== null && r.approvalReason !== filter.approvalReason) return false;
  if (
    filter.requestOrCustomerId !== null &&
    r.id !== filter.requestOrCustomerId &&
    r.customerAccountId !== filter.requestOrCustomerId
  ) {
    return false;
  }
  if (filter.requestedBy !== null && r.requestedBy !== filter.requestedBy) return false;
  if (filter.from !== null && Temporal.Instant.compare(r.requestedAt, filter.from) < 0)
    return false;
  if (filter.to !== null && Temporal.Instant.compare(r.requestedAt, filter.to) >= 0) return false;
  if (filter.minAmount !== null && r.amountMinor < filter.minAmount) return false;
  if (filter.maxAmount !== null && r.amountMinor > filter.maxAmount) return false;
  return true;
}

function compare(a: AdminCreditRecord, b: AdminCreditRecord, sort: CreditSort): number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  let order: number;
  switch (sort.key) {
    case 'amount':
      order = a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0;
      break;
    case 'expires':
    case 'decided': {
      const field = sort.key === 'expires' ? 'expiresAt' : 'decidedAt';
      const x = a[field];
      const y = b[field];
      // No expiry or no decision yet sorts last either way.
      if ((x === null) !== (y === null)) return x === null ? 1 : -1;
      order = x === null || y === null ? 0 : Temporal.Instant.compare(x, y);
      break;
    }
    default:
      order = Temporal.Instant.compare(a.requestedAt, b.requestedAt);
  }
  if (order === 0) order = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return order * sign;
}

export class MemoryAdminCreditList implements AdminCreditListReader {
  /** Every read, so a test can see that nothing was read before a refusal. */
  reads = 0;

  constructor(private readonly rowsOf: (market: MarketContext) => readonly AdminCreditRecord[]) {}

  #rows(market: MarketContext): AdminCreditRecord[] {
    this.reads += 1;
    return [...this.rowsOf(market)];
  }

  page(
    market: MarketContext,
    filter: CreditListFilter,
    sort: CreditSort,
    offset: number,
    limit: number,
    after: CreditListCursor | null = null,
  ) {
    const rows = this.#rows(market)
      .filter((r) => matches(r, filter))
      .filter(
        (r) =>
          after === null ||
          Temporal.Instant.compare(r.requestedAt, after.requestedAt) < 0 ||
          (Temporal.Instant.compare(r.requestedAt, after.requestedAt) === 0 && r.id < after.id),
      )
      .sort((a, b) => compare(a, b, sort));
    return Promise.resolve(rows.slice(offset, offset + limit));
  }

  async idsPage(market: MarketContext, filter: CreditListFilter, sort: CreditSort, limit: number) {
    return (await this.page(market, filter, sort, 0, limit)).map((r) => r.id);
  }

  count(market: MarketContext, filter: CreditListFilter) {
    return Promise.resolve(this.#rows(market).filter((r) => matches(r, filter)).length);
  }

  countByStatus(market: MarketContext): Promise<CreditStatusCounts> {
    const counts = Object.fromEntries(ADMIN_CREDIT_STATUSES.map((s) => [s, 0])) as Record<
      AdminCreditStatus,
      number
    >;
    for (const r of this.#rows(market)) counts[r.status] += 1;
    return Promise.resolve(counts);
  }

  byIds(market: MarketContext, ids: readonly Id<'WalletCreditRequest'>[]) {
    return Promise.resolve(this.#rows(market).filter((r) => ids.includes(r.id)));
  }
}
