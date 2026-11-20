import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import type { PermissionProbe } from '../../src/platform/list-query';
import type { AdminPayoutListReader } from '../../src/modules/commission-payouts/application/ports/admin-payout-list.reader';
import type { StoreNameSearch } from '../../src/modules/commission-payouts/application/ports/store-name-search';
import type {
  PayoutListCursor,
  PayoutListFilter,
  PayoutSlotCursor,
  PayoutSort,
  PayoutStateCounts,
} from '../../src/modules/commission-payouts/domain/admin-payout-list';
import { PAYOUT_STATES, type Payout } from '../../src/modules/commission-payouts/domain/payout';
import type { MemoryHolds } from './commission-payouts-fakes';
import type { MemoryPayouts } from './commission-payouts-payout-fakes';

// In-memory stand-ins for the admin Payouts list (super list 21): the reader works over the same
// rows as MemoryPayouts and MemoryHolds, with the filter, sort and cursor of the Prisma reader.

const inMarket = (market: MarketContext, k: string) => k.startsWith(`${market.marketId}:`);

function matches(payout: Payout, filter: PayoutListFilter): boolean {
  if (filter.states !== null && !filter.states.includes(payout.state)) return false;
  if (filter.state !== null && payout.state !== filter.state) return false;
  if (filter.payoutId !== null && payout.id !== filter.payoutId) return false;
  if (filter.sellerId !== null && payout.sellerId !== filter.sellerId) return false;
  if (filter.sellerIds !== null && !filter.sellerIds.includes(payout.sellerId)) return false;
  if (filter.approvalMode !== null && payout.approvalMode !== filter.approvalMode) return false;
  const dated = filter.dateOn === 'slot' ? payout.slotAt : payout.createdAt;
  if (filter.from !== null && Temporal.Instant.compare(dated, filter.from) < 0) return false;
  if (filter.to !== null && Temporal.Instant.compare(dated, filter.to) >= 0) return false;
  if (filter.minAmount !== null && payout.transfer < filter.minAmount) return false;
  if (filter.maxAmount !== null && payout.transfer > filter.maxAmount) return false;
  return true;
}

function compare(a: Payout, b: Payout, sort: PayoutSort): number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  let order: number;
  switch (sort.key) {
    case 'amount':
      order = a.transfer < b.transfer ? -1 : a.transfer > b.transfer ? 1 : 0;
      break;
    case 'state-changed':
      order = Temporal.Instant.compare(a.stateChangedAt, b.stateChangedAt);
      break;
    case 'slot':
      order = Temporal.Instant.compare(a.slotAt, b.slotAt);
      break;
    default:
      order = Temporal.Instant.compare(a.createdAt, b.createdAt);
  }
  if (order === 0) order = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return order * sign;
}

export class MemoryAdminPayoutList implements AdminPayoutListReader {
  /** Every read, so a test can see that nothing was read before a refusal. */
  reads = 0;

  constructor(
    private readonly payouts: MemoryPayouts,
    private readonly holds?: MemoryHolds,
  ) {}

  #rows(market: MarketContext): Payout[] {
    this.reads += 1;
    return [...this.payouts.rows.entries()]
      .filter(([k]) => inMarket(market, k))
      .map(([, payout]) => payout);
  }

  page(
    market: MarketContext,
    filter: PayoutListFilter,
    sort: PayoutSort,
    offset: number,
    limit: number,
    after: PayoutListCursor | PayoutSlotCursor | null = null,
  ) {
    const before = (payout: Payout): boolean => {
      if (after === null) return true;
      const order =
        'slotAt' in after
          ? Temporal.Instant.compare(payout.slotAt, after.slotAt)
          : Temporal.Instant.compare(payout.createdAt, after.createdAt);
      return order < 0 || (order === 0 && payout.id < after.payoutId);
    };
    const rows = this.#rows(market)
      .filter((payout) => matches(payout, filter))
      .filter(before)
      .sort((a, b) => compare(a, b, sort));
    return Promise.resolve(rows.slice(offset, offset + limit));
  }

  async idsPage(market: MarketContext, filter: PayoutListFilter, sort: PayoutSort, limit: number) {
    return (await this.page(market, filter, sort, 0, limit)).map((payout) => payout.id);
  }

  count(market: MarketContext, filter: PayoutListFilter) {
    return Promise.resolve(this.#rows(market).filter((payout) => matches(payout, filter)).length);
  }

  countByState(
    market: MarketContext,
    sellerId: Id<'Seller'> | null = null,
  ): Promise<PayoutStateCounts> {
    const counts = Object.fromEntries(PAYOUT_STATES.map((state) => [state, 0])) as Record<
      Payout['state'],
      number
    >;
    for (const payout of this.#rows(market)) {
      if (sellerId === null || payout.sellerId === sellerId) counts[payout.state] += 1;
    }
    return Promise.resolve(counts);
  }

  byIds(market: MarketContext, ids: readonly Id<'Payout'>[]) {
    return Promise.resolve(this.#rows(market).filter((payout) => ids.includes(payout.id)));
  }

  activeAdminHolds(market: MarketContext, sellerIds: readonly Id<'Seller'>[]) {
    const found = new Map<Id<'Seller'>, Id<'PayoutHold'>>();
    const rows = [...(this.holds?.rows.entries() ?? [])]
      .filter(([k]) => inMarket(market, k))
      .map(([, hold]) => hold)
      .filter(
        (hold) =>
          hold.origin === 'admin' &&
          hold.sellerOrderId === null &&
          hold.releasedAt === null &&
          sellerIds.includes(hold.sellerId),
      )
      .sort(
        (a, b) =>
          Temporal.Instant.compare(b.placedAt, a.placedAt) ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
    for (const hold of rows) if (!found.has(hold.sellerId)) found.set(hold.sellerId, hold.id);
    return Promise.resolve(found);
  }
}

/** Store search by a part of the name, over a map of names; `failing` makes it throw. */
export class FakeStoreSearch implements StoreNameSearch {
  failing = false;
  capped = false;
  readonly terms: string[] = [];
  constructor(private readonly names: ReadonlyMap<string, string>) {}
  storesMatching(_context: CallContext, term: string) {
    this.terms.push(term);
    if (this.failing) return Promise.reject(new Error('sellers down'));
    const sellerIds = [...this.names.entries()]
      .filter(([, name]) => name.toLowerCase().includes(term.toLowerCase()))
      .map(([id]) => id as Id<'Seller'>);
    return Promise.resolve({ sellerIds, capped: this.capped });
  }
}

/** A probe whose answer the test sets: `held` true answers ok, false access.denied. */
export class ScriptedProbe implements PermissionProbe {
  constructor(public held: boolean) {}
  execute() {
    return Promise.resolve(this.held ? ok({ held: true as const }) : { ok: false as const });
  }
}
