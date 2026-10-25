import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { BOUGHT_TOGETHER_WINDOW_DAYS } from '../../contracts';
import { OfferPairCounter } from '../../domain/offer-pairs';
import type { OfferPairStore } from '../ports/offer-pairs.store';

export interface RebuildOfferPairsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly pairs: OfferPairStore;
  readonly clock: Clock;
}

/** Orders read per page while counting. */
export const ORDER_PAGE_SIZE = 500;

export interface OfferPairsRebuilt {
  /** Rows stored (both directions). */
  readonly rows: number;
}

/**
 * `ordering.rebuild-offer-pairs`: for one Market, counts the Offer pairs that share at least 3
 * distinct paid orders (confirmed, by confirmation time) over the last
 * {@link BOUGHT_TOGETHER_WINDOW_DAYS} days and replaces the Market's pair table with them. The
 * whole rebuild (reads, delete, insert) is one unit, so a reader sees the old table or the new
 * one. Rule `system`: run by the nightly job only. Safe to run twice: the same orders give the
 * same pairs.
 */
export class RebuildOfferPairs extends UseCase<Record<string, never>, OfferPairsRebuilt, never> {
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

  protected handle(context: CallContext): Promise<Result<OfferPairsRebuilt, never>> {
    const { market } = context;
    const now = this.deps.clock.now();
    const since = now.subtract({ hours: BOUGHT_TOGETHER_WINDOW_DAYS * 24 });
    return this.deps.unitOfWork.run<OfferPairsRebuilt, never>(market, async () => {
      const counter = new OfferPairCounter();
      let after: string | null = null;
      for (;;) {
        const page = await this.deps.pairs.confirmedOrders(market, since, after, ORDER_PAGE_SIZE);
        for (const order of page.orders) counter.add(order.offerIds);
        if (page.orders.length < ORDER_PAGE_SIZE) break;
        after = page.orders[page.orders.length - 1]!.orderId;
      }
      const rows = await this.deps.pairs.replacePairs(market, counter.pairs(), now);
      return ok({ rows });
    });
  }
}
