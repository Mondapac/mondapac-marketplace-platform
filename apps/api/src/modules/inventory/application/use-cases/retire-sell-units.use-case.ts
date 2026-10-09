import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { availabilityOf } from '../../domain/stock';
import type { AvailabilitySignalRepository } from '../ports/availability-signal.repository';
import type { RetirementTarget, StockItemRow, StockRepository } from '../ports/stock.repository';
import { runSerializableOnce } from '../serializable-unit';
import { writeSignal } from '../signal-writer';

/** One delivery of `catalog.offer-deleted.v1` or `catalog.variant-removed.v1` (design 3.5). */
export interface RetireSellUnitsInput {
  readonly delivery: EventDelivery;
  /** An Offer, or a Variant across every Offer: the event names no more than that. */
  readonly target: RetirementTarget;
  /** The `aggregateVersion` of the catalog event, kept on the tombstone for audit. */
  readonly sourceAggregateVersion: number;
}

export type RetireSellUnitsOutput =
  | { readonly code: 'inventory.retired'; readonly items: number; readonly sellUnits: number }
  | { readonly code: 'inventory.retire.already-handled' };

export type RetireSellUnitsFailure = { readonly code: 'access.denied' };

export interface RetireSellUnitsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly stock: StockRepository;
  readonly signals: AvailabilitySignalRepository;
  readonly outbox: OutboxWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/**
 * The handler `inventory.retire-sell-units` (inventory design 3.5, 4.5; data design 4.4; F2).
 * Rule `system`, from the subscriptions on `catalog.offer-deleted.v1` and
 * `catalog.variant-removed.v1`. In one `serializable` unit opened through the inbox's `runOnce`:
 *
 * 1. read the ids of the target's active items (ascending), then lock them with the named
 *    statement, in ascending batches (lock rule L1; nothing to lock is fine);
 * 2. record the tombstone, so a stock write that arrives later cannot re-create the sell unit
 *    (events are unordered, ADR-0006 decision 3); an existing tombstone is left as it is;
 * 3. set `retired_at` on the locked items that are not retired, one way (M6);
 * 4. recompute the signal of every sell unit it retired (all its items are retired now, so
 *    `out`, design 5.3) and append the events.
 *
 * The write skew with `set-stock-level` (creating the first item while the sell unit is being
 * retired) is closed by SERIALIZABLE on both: PostgreSQL refuses one with `40001` and the
 * UnitOfWork runs it again, so the retried creator sees the tombstone. A second delivery of the
 * same event stops at the inbox; another event for the same target finds nothing active and
 * leaves the tombstone. Never in `catalog`'s transaction. Logs hold ids, codes and counts only.
 */
export class RetireSellUnits extends UseCase<
  RetireSellUnitsInput,
  RetireSellUnitsOutput,
  RetireSellUnitsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.retire-sell-units',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('RetireSellUnits');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RetireSellUnitsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RetireSellUnitsInput,
  ): Promise<Result<RetireSellUnitsOutput, RetireSellUnitsFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, stock, ids, clock } = this.deps;
    const { target } = input;

    const handled = await runSerializableOnce(unitOfWork, market, input.delivery, async () => {
      const now = clock.now();
      const found = await stock.activeItemIds(market, target);
      const locked = found.length === 0 ? [] : await stock.lockItems(market, found);
      await stock.recordTombstone(market, {
        id: ids.next<'Retirement'>(),
        target,
        sourceAggregateVersion: input.sourceAggregateVersion,
        retiredAt: now,
      });
      // Retired by another unit between the read and the lock: nothing left to do for those.
      const toRetire = locked.filter((item) => !item.retired);
      if (toRetire.length > 0) {
        const changed = await stock.retireItems(
          market,
          toRetire.map((item) => item.id),
          now,
        );
        // We hold their locks: a different count is a bug, so the unit rolls back.
        if (changed !== toRetire.length) {
          throw new Error('inventory: a locked stock item was retired under its lock');
        }
      }
      const sellUnits = sellUnitsOf(toRetire);
      for (const unit of sellUnits) {
        await writeSignal(this.deps, context, market, {
          ...unit,
          // Every item of the sell unit is retired, so its sellable is 0: `out` whatever the
          // seller's threshold is.
          next: availabilityOf(0, 0),
          now,
        });
      }
      return ok({ items: toRetire.length, sellUnits: sellUnits.length });
    });
    if (!handled.ok) throw new Error('retire-sell-units: the unit failed');

    const output: RetireSellUnitsOutput = handled.value.handled
      ? {
          code: 'inventory.retired',
          items: handled.value.value.items,
          sellUnits: handled.value.value.sellUnits,
        }
      : { code: 'inventory.retire.already-handled' };
    this.#logger.log({
      msg: output.code,
      scope: target.scope,
      ...(output.code === 'inventory.retired'
        ? { items: output.items, sellUnits: output.sellUnits }
        : {}),
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }
}

interface SellUnit {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly sellerId: Id<'Seller'>;
}

/** The distinct sell units of the items, in a stable order (offer, then variant). */
function sellUnitsOf(items: readonly StockItemRow[]): SellUnit[] {
  const byKey = new Map<string, SellUnit>();
  for (const item of items) {
    byKey.set(`${item.offerId}|${item.variantId}`, {
      offerId: item.offerId,
      variantId: item.variantId,
      sellerId: item.sellerId,
    });
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, unit]) => unit);
}
