import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  MAX_UNIT_TIMEOUT_MS,
  type UnitOfWork,
} from '../../../../platform/unit-of-work/unit-of-work';
import { BOUGHT_TOGETHER_WINDOW_DAYS } from '../../contracts';
import { MAX_COUNTER_ENTRIES, OfferPairCounter, storedRows } from '../../domain/offer-pairs';
import type { OfferPairStore, OrderCursor } from '../ports/offer-pairs.store';

export interface RebuildOfferPairsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly pairs: OfferPairStore;
  readonly clock: Clock;
  /** The counter's ceiling (pair keys plus buyer entries); {@link MAX_COUNTER_ENTRIES} unless a test lowers it. */
  readonly maxCounterEntries?: number;
}

/** Orders read per page while counting. */
export const ORDER_PAGE_SIZE = 500;

export interface OfferPairsRebuilt {
  /** Rows stored. */
  readonly rows: number;
  /** Orders left out because they hold too many distinct Offers. */
  readonly skippedLargeOrders: number;
}

export type OfferPairsRebuildFailure = { readonly code: 'ordering.offer-pairs-too-many' };

/**
 * `ordering.rebuild-offer-pairs`: for one Market, counts the Offer pairs that at least 3 distinct
 * buyer accounts bought together, in one paid order each (confirmed from 90 days before the Clock's now up to now, by confirmation
 * time; the buyer account id is read here, held in memory only and never stored or logged) and
 * replaces the Market's pair table with them. The orders are read page by page, each page
 * in its own read-only unit (no transaction, ADR-0025), and counted in memory; only the replacement
 * (delete and insert) runs in one read-write unit with the longest unit timeout, so a reader sees
 * the old table or the new one. If the counter's ceiling is hit the rebuild is refused and the old
 * table stays. Rule `system`: run by the nightly job only. Safe to run twice: the same orders give
 * the same pairs.
 */
export class RebuildOfferPairs extends UseCase<
  Record<string, never>,
  OfferPairsRebuilt,
  OfferPairsRebuildFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.rebuild-offer-pairs',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RebuildOfferPairsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<OfferPairsRebuilt, OfferPairsRebuildFailure>> {
    const { market } = context;
    const { unitOfWork, pairs } = this.deps;
    const until = this.deps.clock.now();
    const since = until.subtract({ hours: BOUGHT_TOGETHER_WINDOW_DAYS * 24 });
    const counter = new OfferPairCounter(this.deps.maxCounterEntries ?? MAX_COUNTER_ENTRIES);
    let skippedLargeOrders = 0;
    let after: OrderCursor | null = null;
    for (;;) {
      const read = await unitOfWork.run(
        market,
        async () =>
          ok(await pairs.confirmedOrders(market, { since, until }, after, ORDER_PAGE_SIZE)),
        { readOnly: true },
      );
      if (!read.ok) throw new Error('ordering.rebuild-offer-pairs: read failed');
      const page = read.value;
      for (const order of page.orders) {
        const outcome = counter.add(order.accountId, order.offerIds);
        if (outcome === 'ceiling') return err({ code: 'ordering.offer-pairs-too-many' });
        if (outcome === 'skipped-large') skippedLargeOrders += 1;
      }
      const last = page.orders[page.orders.length - 1];
      if (last === undefined || page.orders.length < ORDER_PAGE_SIZE) break;
      after = { confirmedAt: last.confirmedAt, orderId: last.orderId };
    }
    const rows = storedRows(counter.pairs());
    return unitOfWork.run<OfferPairsRebuilt, OfferPairsRebuildFailure>(
      market,
      async () => ok({ rows: await pairs.replacePairs(market, rows, until), skippedLargeOrders }),
      { timeoutMs: MAX_UNIT_TIMEOUT_MS },
    );
  }
}
