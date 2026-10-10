import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  MarketContext,
  Result,
} from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { INVENTORY_STOCK_EDIT } from '../../contracts/permissions';
import { availabilityOf, parseStockLevel, sellableOfSellUnit } from '../../domain/stock';
import type { AvailabilitySignalRepository } from '../ports/availability-signal.repository';
import type { InventoryPolicyProvider } from '../ports/inventory-policy-provider';
import type { OfferSellUnitsSource } from '../ports/offer-sell-units';
import type { SellerInventoryRepository } from '../ports/seller-inventory.repository';
import type { StockItemRow, StockRepository } from '../ports/stock.repository';
import { runSerializable } from '../serializable-unit';
import { writeSignal } from '../signal-writer';
import {
  checkSourceId,
  checkVersion,
  NOT_READY,
  sellerOf,
  STALE,
  validationFailed,
  type SellerNotReady,
  type ValidationFailed,
} from '../source-use-case-support';

export interface SetStockLevelInput {
  readonly offerId: string;
  readonly variantId: string;
  readonly sourceId: string;
  /** The level to set: a whole number from 0. */
  readonly onHand: number;
  /**
   * The item's version the seller's screen showed, or null when it showed no item for this
   * source (data design 3.4: optimistic version). A mismatch answers `conflict.stale`.
   */
  readonly expectedVersion: number | null;
}

export interface SetStockLevelOutput {
  readonly stockItemId: Id<'StockItem'>;
  readonly onHand: number;
  /** What the screen sends next time. Unchanged when the level was the same (M4). */
  readonly version: number;
  /** False when the level equalled the stored one: no movement, no version raise. */
  readonly changed: boolean;
}

export type SetStockLevelFailure =
  | ValidationFailed
  | SellerNotReady
  | { readonly code: 'access.denied' }
  /** Unknown, another seller's, another Market's, deleted or retired: all one answer (AC 11). */
  | { readonly code: 'inventory.not-found' }
  | { readonly code: 'conflict.stale' }
  | {
      readonly code: 'inventory.stock.below-held';
      readonly details: { readonly min: number };
    };

export interface SetStockLevelDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly inventories: SellerInventoryRepository;
  readonly stock: StockRepository;
  readonly signals: AvailabilitySignalRepository;
  readonly offers: OfferSellUnitsSource;
  readonly policies: InventoryPolicyProvider;
  readonly outbox: OutboxWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

const NOT_FOUND = Object.freeze({ code: 'inventory.not-found' as const });

/**
 * `inventory.set-stock-level` (inventory design 4.5, 6; data design 4.4): the seller sets the level
 * of one stock item, creating it on the first write, and the sell unit's availability signal is
 * recomputed in the same unit.
 *
 * 1. The seller comes from the actor. Outside any unit, catalog's `offerSellUnits` must answer
 *    for the Offer: present, the actor's seller, not deleted, and the Variant one of its sell
 *    units. Advisory (ADR-0025 decision 1), so the tombstone inside the unit is the backstop.
 * 2. In a `serializable` unit (F2): the seller's inventory proves the source is theirs, the
 *    sell unit's items are locked (L1) and the tombstones read (a covered or retired sell unit,
 *    or an item of another seller, answers not found), then the item is created or its version
 *    checked, the level refused below what is held (AC 9), the item and the ledger written, the
 *    signal recomputed and the events appended.
 *
 * Every refusal about the Offer, the Variant, the source or the seller answers the same
 * `inventory.not-found`, so an id cannot be probed (AC 11). Setting the stored level is not a
 * change: nothing is written and the version does not rise (M4). Not in this part: the acting-as
 * refusal (SEL-08 does not exist; see the tripwire spec) and the route.
 */
export class SetStockLevel extends UseCase<
  SetStockLevelInput,
  SetStockLevelOutput,
  SetStockLevelFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.set-stock-level',
    rule: { kind: 'permissions', allOf: [INVENTORY_STOCK_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('SetStockLevel');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SetStockLevelDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SetStockLevelInput,
  ): Promise<Result<SetStockLevelOutput, SetStockLevelFailure>> {
    const sellerId = sellerOf(context);
    const { actor } = context;
    if (sellerId === null || actor.kind !== 'authenticated') {
      return err({ code: 'access.denied' });
    }
    const checked = this.check(input);
    if (!checked.ok) return checked;
    const { offerId, variantId } = checked.value;

    const offers = await this.deps.offers.sellUnitsOf(context, [offerId]);
    const offer = offers.get(offerId);
    if (
      offer === undefined ||
      offer.sellerId !== sellerId ||
      offer.deleted ||
      !offer.sellUnitVariantIds.has(variantId)
    ) {
      return this.refused(context, NOT_FOUND);
    }

    const { market } = context;
    const result = await runSerializable(this.deps.unitOfWork, market, () =>
      this.write(context, market, sellerId, actor.accountId, checked.value),
    );
    if (!result.ok) return this.refused(context, result.error);
    this.#logger.log({
      msg: 'inventory.set-stock-level.done',
      changed: result.value.changed,
      version: result.value.version,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  /** Input shape: ids and numbers only, so a refusal names paths and rule codes (no values). */
  private check(input: SetStockLevelInput): Result<Checked, SetStockLevelFailure> {
    const fields: { path: string; code: string }[] = [];
    const offerId = parseId<'Offer'>(input?.offerId);
    if (!offerId.ok) fields.push({ path: 'offerId', code: 'format' });
    const variantId = parseId<'Variant'>(input?.variantId);
    if (!variantId.ok) fields.push({ path: 'variantId', code: 'format' });
    const sourceId = checkSourceId(input?.sourceId, 'sourceId', fields);
    const onHand = parseStockLevel(input?.onHand);
    if (onHand === null) fields.push({ path: 'onHand', code: 'range' });
    let expectedVersion: number | null = null;
    if (input?.expectedVersion !== null && input?.expectedVersion !== undefined) {
      expectedVersion = checkVersion(input.expectedVersion, fields);
    }
    if (fields.length > 0 || !offerId.ok || !variantId.ok || sourceId === null || onHand === null) {
      return validationFailed(fields);
    }
    return ok({
      offerId: offerId.value,
      variantId: variantId.value,
      sourceId,
      onHand,
      expectedVersion,
    });
  }

  private async write(
    context: CallContext,
    market: MarketContext,
    sellerId: Id<'Seller'>,
    accountId: Id<'Account'>,
    input: Checked,
  ): Promise<Result<SetStockLevelOutput, SetStockLevelFailure>> {
    const { inventories, stock, ids, clock, policies } = this.deps;
    const { offerId, variantId, sourceId, onHand, expectedVersion } = input;
    const now = clock.now();

    // The source must be this seller's (the foreign key proves it again at the insert).
    const inventory = await inventories.findBySeller(market, sellerId);
    if (inventory === null) return err(NOT_READY);
    if (!inventory.state.sources.some((source) => source.id === sourceId)) return err(NOT_FOUND);
    const threshold =
      inventory.state.lowStockThreshold ?? policies.defaultLowStockThreshold(market);

    // Lock (L1), then the tombstones (data design 4.4), then the item.
    const items = await stock.lockSellUnit(market, offerId, variantId);
    if (items.some((item) => item.sellerId !== sellerId)) return err(NOT_FOUND);
    if (await stock.isSellUnitRetired(market, offerId, variantId)) return err(NOT_FOUND);
    const own = items.find((item) => item.sourceId === sourceId) ?? null;
    if (own?.retired === true) return err(NOT_FOUND);
    if ((own?.version ?? null) !== expectedVersion) return err(STALE);

    const held = await stock.heldQuantities(
      market,
      items.map((item) => item.id),
      now,
    );
    if (own !== null) {
      if (own.onHand === onHand) {
        return ok({ stockItemId: own.id, onHand, version: own.version, changed: false });
      }
      const min = held.get(own.id) ?? 0;
      if (onHand < min) return err({ code: 'inventory.stock.below-held', details: { min } });
    }

    let itemId: Id<'StockItem'>;
    let version: number;
    let previous: number;
    if (own === null) {
      itemId = ids.next<'StockItem'>();
      version = 1;
      previous = 0;
      await stock.insertItem(market, {
        id: itemId,
        offerId,
        variantId,
        sourceId,
        sellerId,
        onHand,
        createdAt: now,
      });
    } else {
      itemId = own.id;
      previous = own.onHand;
      version = own.version + 1;
      if ((await stock.setOnHand(market, own.id, own.version, onHand)) === 'stale') {
        return err(STALE);
      }
    }
    // A ledger row only for a change (the delta CHECK refuses 0): a new item at 0 has none.
    if (onHand !== previous) {
      await stock.appendMovement(market, {
        id: ids.next<'StockMovement'>(),
        stockItemId: itemId,
        offerId,
        variantId,
        delta: onHand - previous,
        resultingOnHand: onHand,
        reason: 'seller-set',
        actorAccountId: accountId,
        correlationId: context.correlationId,
        occurredAt: now,
      });
    }

    // The signal, under the lock (design 5.3).
    const after: readonly StockItemRow[] = [
      ...items.filter((item) => item.id !== itemId),
      ...(own === null
        ? [{ id: itemId, offerId, variantId, sourceId, sellerId, onHand, retired: false, version }]
        : [{ ...own, onHand, version }]),
    ];
    const sellable = sellableOfSellUnit(
      after.map((item) => ({
        onHand: item.onHand,
        held: held.get(item.id) ?? 0,
        retired: item.retired,
      })),
    );
    await writeSignal(this.deps, context, market, {
      offerId,
      variantId,
      sellerId,
      next: availabilityOf(sellable, threshold),
      now,
    });
    return ok({ stockItemId: itemId, onHand, version, changed: true });
  }

  private refused(
    context: CallContext,
    failure: SetStockLevelFailure,
  ): Result<never, SetStockLevelFailure> {
    this.#logger.log({
      msg: 'inventory.set-stock-level.refused',
      code: failure.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err(failure);
  }
}

interface Checked {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly sourceId: Id<'InventorySource'>;
  readonly onHand: number;
  readonly expectedVersion: number | null;
}
