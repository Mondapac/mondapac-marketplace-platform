import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { CommissionPayoutsDependencies } from '../../src/modules/commission-payouts/application/commission-payouts-dependencies';
import {
  HOLD_ROW_KEYS,
  type SellerPageListDependencies,
} from '../../src/modules/commission-payouts/application/seller-page-lists-flow';
import { ExceljsSheetWriter } from '../../src/platform/list-export';
import type { PayoutHoldRecord } from '../../src/modules/commission-payouts/application/ports/payout-hold.repository';
import type { SellerPageListReader } from '../../src/modules/commission-payouts/application/ports/seller-page-list.reader';
import type { LedgerEntry } from '../../src/modules/commission-payouts/domain/ledger';
import type {
  HoldListCursor,
  HoldListFilter,
  HoldSort,
  HoldStatusCounts,
  LedgerListCursor,
  LedgerListFilter,
  LedgerSort,
} from '../../src/modules/commission-payouts/domain/seller-page-lists';

// An in-memory stand-in for the seller page's two lists (super lists 27 and 28), over the rows a
// test already keeps, with the filter, sort and cursor of the Prisma reader.

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
const within = (at: Temporal.Instant, from: Temporal.Instant | null, to: Temporal.Instant | null) =>
  (from === null || Temporal.Instant.compare(at, from) >= 0) &&
  (to === null || Temporal.Instant.compare(at, to) < 0);

function ledgerMatches(entry: LedgerEntry, filter: LedgerListFilter): boolean {
  if (entry.sellerId !== filter.sellerId) return false;
  if (filter.kinds !== null && !filter.kinds.includes(entry.kind)) return false;
  if (
    filter.reference !== null &&
    entry.orderId !== filter.reference &&
    entry.sellerOrderId !== filter.reference
  ) {
    return false;
  }
  if (!within(entry.recordedAt, filter.from, filter.to)) return false;
  if (filter.minAmount !== null && entry.amount.amount < filter.minAmount) return false;
  if (filter.maxAmount !== null && entry.amount.amount > filter.maxAmount) return false;
  return true;
}

function ledgerCompare(a: LedgerEntry, b: LedgerEntry, sort: LedgerSort): number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  let order =
    sort.key === 'amount'
      ? cmp(a.amount.amount, b.amount.amount)
      : sort.key === 'occurred'
        ? Temporal.Instant.compare(a.occurredAt, b.occurredAt)
        : Temporal.Instant.compare(a.recordedAt, b.recordedAt);
  if (order === 0) order = byId(a, b);
  return order * sign;
}

function holdMatches(hold: PayoutHoldRecord, filter: HoldListFilter): boolean {
  if (hold.sellerId !== filter.sellerId) return false;
  if (filter.status === 'active' && hold.releasedAt !== null) return false;
  if (filter.status === 'released' && hold.releasedAt === null) return false;
  if (filter.reason !== null && hold.reason !== filter.reason) return false;
  if (filter.origin !== null && hold.origin !== filter.origin) return false;
  if (filter.scope === 'seller' && hold.sellerOrderId !== null) return false;
  if (filter.scope === 'order' && hold.sellerOrderId === null) return false;
  if (filter.sellerOrderId !== null && hold.sellerOrderId !== filter.sellerOrderId) return false;
  return within(hold.placedAt, filter.from, filter.to);
}

function holdCompare(a: PayoutHoldRecord, b: PayoutHoldRecord, sort: HoldSort): number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  const placed = Temporal.Instant.compare(a.placedAt, b.placedAt);
  let order: number;
  if (sort.key === 'released') {
    // Nulls last in both directions.
    if (a.releasedAt === null || b.releasedAt === null) {
      if (a.releasedAt === b.releasedAt) return byId(a, b) * sign;
      return a.releasedAt === null ? 1 : -1;
    }
    order = Temporal.Instant.compare(a.releasedAt, b.releasedAt);
  } else if (sort.key === 'placed') {
    order = placed;
  } else {
    // Active first when descending (nulls first), last when ascending; then the placement.
    const activeA = a.releasedAt === null ? 1 : 0;
    const activeB = b.releasedAt === null ? 1 : 0;
    order = activeA - activeB;
    if (order === 0 && a.releasedAt !== null && b.releasedAt !== null) {
      order = Temporal.Instant.compare(a.releasedAt, b.releasedAt);
    }
    if (order === 0) order = placed;
  }
  if (order === 0) order = byId(a, b);
  return order * sign;
}

export class MemorySellerPageLists implements SellerPageListReader {
  /** Every read, so a test can see that nothing was read before a refusal. */
  reads = 0;

  constructor(
    private readonly ledgerRows: (market: MarketContext) => readonly LedgerEntry[],
    private readonly holdRows: (market: MarketContext) => readonly PayoutHoldRecord[],
  ) {}

  #ledger(market: MarketContext, filter: LedgerListFilter, sort: LedgerSort) {
    this.reads += 1;
    return this.ledgerRows(market)
      .filter((entry) => ledgerMatches(entry, filter))
      .sort((a, b) => ledgerCompare(a, b, sort));
  }

  #holds(market: MarketContext, filter: HoldListFilter, sort: HoldSort) {
    this.reads += 1;
    return this.holdRows(market)
      .filter((hold) => holdMatches(hold, filter))
      .sort((a, b) => holdCompare(a, b, sort));
  }

  ledgerPage(
    market: MarketContext,
    filter: LedgerListFilter,
    sort: LedgerSort,
    offset: number,
    limit: number,
    after: LedgerListCursor | null = null,
  ) {
    const rows = this.#ledger(market, filter, sort).filter(
      (entry) =>
        after === null ||
        Temporal.Instant.compare(entry.recordedAt, after.recordedAt) < 0 ||
        (Temporal.Instant.compare(entry.recordedAt, after.recordedAt) === 0 &&
          entry.id < after.entryId),
    );
    return Promise.resolve(rows.slice(offset, offset + limit));
  }

  ledgerIds(market: MarketContext, filter: LedgerListFilter, sort: LedgerSort, limit: number) {
    return Promise.resolve(
      this.#ledger(market, filter, sort)
        .slice(0, limit)
        .map((entry) => entry.id),
    );
  }

  ledgerCount(market: MarketContext, filter: LedgerListFilter) {
    return Promise.resolve(
      this.#ledger(market, filter, { key: 'recorded', direction: 'desc' }).length,
    );
  }

  ledgerByIds(market: MarketContext, sellerId: Id<'Seller'>, ids: readonly Id<'LedgerEntry'>[]) {
    this.reads += 1;
    return Promise.resolve(
      this.ledgerRows(market).filter(
        (entry) => entry.sellerId === sellerId && ids.includes(entry.id),
      ),
    );
  }

  holdPage(
    market: MarketContext,
    filter: HoldListFilter,
    sort: HoldSort,
    offset: number,
    limit: number,
    after: HoldListCursor | null = null,
  ) {
    const rows = this.#holds(market, filter, sort).filter(
      (hold) =>
        after === null ||
        Temporal.Instant.compare(hold.placedAt, after.placedAt) < 0 ||
        (Temporal.Instant.compare(hold.placedAt, after.placedAt) === 0 && hold.id < after.holdId),
    );
    return Promise.resolve(rows.slice(offset, offset + limit));
  }

  holdIds(market: MarketContext, filter: HoldListFilter, sort: HoldSort, limit: number) {
    return Promise.resolve(
      this.#holds(market, filter, sort)
        .slice(0, limit)
        .map((hold) => hold.id),
    );
  }

  holdCount(market: MarketContext, filter: HoldListFilter) {
    return Promise.resolve(
      this.#holds(market, filter, { key: 'placed', direction: 'desc' }).length,
    );
  }

  holdCounts(market: MarketContext, sellerId: Id<'Seller'>): Promise<HoldStatusCounts> {
    this.reads += 1;
    const mine = this.holdRows(market).filter((hold) => hold.sellerId === sellerId);
    const active = mine.filter((hold) => hold.releasedAt === null).length;
    return Promise.resolve({ active, released: mine.length - active });
  }

  holdByIds(market: MarketContext, sellerId: Id<'Seller'>, ids: readonly Id<'PayoutHold'>[]) {
    this.reads += 1;
    return Promise.resolve(
      this.holdRows(market).filter((hold) => hold.sellerId === sellerId && ids.includes(hold.id)),
    );
  }
}

/**
 * The seller page's dependencies over the ports a commission-payouts spec already builds: the
 * reader reads the rows the test keeps, every probe answers "held" unless `held` says otherwise.
 */
export function sellerPageDepsOf(
  deps: CommissionPayoutsDependencies,
  rows: {
    readonly ledger?: (market: MarketContext) => readonly LedgerEntry[];
    readonly holds?: (market: MarketContext) => readonly PayoutHoldRecord[];
  },
  held = true,
): SellerPageListDependencies & { readonly lists: MemorySellerPageLists } {
  const probe = {
    execute: () => Promise.resolve(held ? ok({ held: true }) : err({ code: 'access.denied' })),
  };
  return {
    unitOfWork: deps.unitOfWork,
    ledger: deps.ledger,
    lists: new MemorySellerPageLists(rows.ledger ?? (() => []), rows.holds ?? (() => [])),
    policy: deps.policy,
    sellers: deps.sellers,
    probes: { [HOLD_ROW_KEYS[0]]: probe },
    sheetWriter: new ExceljsSheetWriter(),
    clock: deps.clock,
  };
}

/** The holds a MemoryHolds keeps for one Market. */
export const holdsOf =
  (holds: { readonly rows: ReadonlyMap<string, PayoutHoldRecord> }) =>
  (market: MarketContext): readonly PayoutHoldRecord[] =>
    [...holds.rows.entries()]
      .filter(([k]) => k.startsWith(`${market.marketId}:`))
      .map(([, hold]) => hold);
