import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { availabilityOf, sellableOfSellUnit } from '../../domain/stock';
import type { ReservationRepository, SellUnitRef } from '../ports/reservation.repository';
import { distinctSellUnits, recomputeSellUnitSignals, sellUnitKey } from '../reservation-support';
import type { AvailabilitySignalRepository } from '../ports/availability-signal.repository';
import type { InventoryPolicyProvider } from '../ports/inventory-policy-provider';
import type { OfferSellUnitsSource } from '../ports/offer-sell-units';
import type { SellerInventoryRepository } from '../ports/seller-inventory.repository';
import type { StockItemRow, StockRepository } from '../ports/stock.repository';
import { runSerializableOnce } from '../serializable-unit';
import { writeSignal } from '../signal-writer';

/** One delivery of `catalog.offer-moved.v1` (inventory design 3.6). */
export interface RekeyMovedOfferInput {
  readonly delivery: EventDelivery;
  readonly offerId: Id<'Offer'>;
  readonly fromProductId: Id<'Product'>;
  readonly toProductId: Id<'Product'>;
  /** `fromVariantIds[i]` becomes `toVariantIds[i]`. */
  readonly fromVariantIds: readonly Id<'Variant'>[];
  readonly toVariantIds: readonly Id<'Variant'>[];
  /** The `aggregateVersion` of the catalog event, kept on the tombstones for audit. */
  readonly sourceAggregateVersion: number;
}

export type RekeyMovedOfferOutput =
  | { readonly code: 'inventory.rekeyed'; readonly sourceItems: number; readonly sellUnits: number }
  | { readonly code: 'inventory.rekey.already-handled' };

export type RekeyMovedOfferFailure =
  | { readonly code: 'access.denied' }
  /** A malformed mapping, or one that does not match catalog's Offer: a catalog bug or a forged event. */
  | { readonly code: 'inventory.rekey.invalid-mapping' }
  | { readonly code: 'inventory.rekey.offer-mismatch' }
  | { readonly code: 'inventory.rekey.lock-set-too-large' };

export interface RekeyMovedOfferDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly inventories: SellerInventoryRepository;
  readonly stock: StockRepository;
  readonly reservations: ReservationRepository;
  readonly signals: AvailabilitySignalRepository;
  readonly offers: OfferSellUnitsSource;
  readonly policies: InventoryPolicyProvider;
  readonly outbox: OutboxWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/**
 * The most items the re-key locks in one call: the named statement's own cap (data design 4.3). A
 * longer set is never split, so the handler fails and an operator moves the stock (design 3.6 step 2).
 */
const MAX_REKEY_LOCK_SET = 1000;

/**
 * The handler `inventory.rekey-moved-offer` (inventory design 3.6; data design 4.4; V-1, Hassan M1
 * and M2). Rule `system`, from the subscription on `catalog.offer-moved.v1`. An Offer that moved to
 * a PLATFORM product keeps its id, but its sell units get new Variant ids, so its stock would be
 * stranded on dead keys. Outside the unit it validates the mapping and checks it against catalog's
 * `offerSellUnits` (M1); then in one `serializable` unit opened through the inbox's `runOnce`:
 *
 * 1. read the ids of every item of the Offer on the `from` and `to` Variants, retired included, plus
 *    every item of the sell units of the live reservations that hold a line on a `from` Variant,
 *    and lock the union in one call (lock rule L1; above the cap it fails, never chunked);
 * 2. tombstones first: an Offer tombstone means only what is left is retired; a Variant tombstone on
 *    a `to` Variant means that pair moves nothing, its items are retired and the quantity logged;
 * 3. per pair and source, `moved = onHand - pending`: create the target item with `moved` and write
 *    the pair of `re-key` movements, or, when the target already exists, leave it as it is (M2) and
 *    write only the `-moved` movement; retire the source item and tombstone the `from` Variant;
 * 4. recompute the signals of the old (now `out`) and new sell units.
 *
 * Before the move (design step 4) every ACTIVE, unexpired reservation with a line on a `from` sell
 * unit is released with cause `offer-moved`, all its lines, other sellers' included, and the signals
 * of those other sell units are recomputed. Pending is then what `heldQuantities` reports: the
 * committed lines only. A replay with the same event stops at the inbox; another event for
 * the same Offer finds the old items retired and moves nothing. Logs hold ids, codes and counts.
 */
export class RekeyMovedOffer extends UseCase<
  RekeyMovedOfferInput,
  RekeyMovedOfferOutput,
  RekeyMovedOfferFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.rekey-moved-offer',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('RekeyMovedOffer');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RekeyMovedOfferDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RekeyMovedOfferInput,
  ): Promise<Result<RekeyMovedOfferOutput, RekeyMovedOfferFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, offers, policies } = this.deps;

    if (!validMapping(input, policies.maxVariantsPerProduct(market))) {
      return this.failed(context, input, 'inventory.rekey.invalid-mapping');
    }
    // Advisory, outside the unit (never in one): catalog's answer must match the event. A catalog
    // that cannot answer throws, so the delivery is retried.
    const view = (await offers.sellUnitsOf(context, [input.offerId])).get(input.offerId);
    if (
      view === undefined ||
      view.deleted ||
      view.productId !== input.toProductId ||
      !input.toVariantIds.every((variantId) => view.sellUnitVariantIds.has(variantId)) ||
      // A `from` Variant that is still a sell unit of the Offer is a forged or stale event: its
      // tombstone would block that Variant for every seller (Hassan, review of PR 219).
      input.fromVariantIds.some((variantId) => view.sellUnitVariantIds.has(variantId))
    ) {
      return this.failed(context, input, 'inventory.rekey.offer-mismatch');
    }

    const handled = await runSerializableOnce(unitOfWork, market, input.delivery, () =>
      this.rekey(context, input, view.sellerId),
    );
    if (!handled.ok) return this.failed(context, input, handled.error.code);

    const output: RekeyMovedOfferOutput = handled.value.handled
      ? handled.value.value
      : { code: 'inventory.rekey.already-handled' };
    this.#logger.log({
      msg: output.code,
      ...(output.code === 'inventory.rekeyed'
        ? { sourceItems: output.sourceItems, sellUnits: output.sellUnits }
        : {}),
      offerId: input.offerId,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }

  private async rekey(
    context: CallContext,
    input: RekeyMovedOfferInput,
    sellerId: Id<'Seller'>,
  ): Promise<
    Result<
      Extract<RekeyMovedOfferOutput, { code: 'inventory.rekeyed' }>,
      Extract<RekeyMovedOfferFailure, { code: `inventory.rekey.${string}` }>
    >
  > {
    const { market } = context;
    const { stock, reservations, inventories, policies, ids, clock } = this.deps;
    const { offerId, fromVariantIds, toVariantIds } = input;
    const now = clock.now();

    // Live holds on the `from` sell units (design 3.6 step 4), read before the lock so their other
    // lines' items join the lock set (L1): a second read, then one lock call with the union.
    const fromUnits: SellUnitRef[] = fromVariantIds.map((variantId) => ({ offerId, variantId }));
    const holds = await reservations.liveOnSellUnits(market, fromUnits, now);
    const heldLines = holds.flatMap((hold) => hold.state.lines);
    const otherUnits = distinctSellUnits(heldLines).filter(
      (unit) => !(unit.offerId === offerId && fromVariantIds.includes(unit.variantId)),
    );
    const otherItems = await reservations.itemsOfSellUnits(market, otherUnits);

    // Lock (L1) first: every item of both sides, retired included, in one call.
    const found = await stock.itemIdsOfOfferVariants(market, offerId, [
      ...fromVariantIds,
      ...toVariantIds,
    ]);
    const union = new Set<Id<'StockItem'>>(found);
    for (const line of heldLines) union.add(line.stockItemId);
    for (const item of otherItems) if (!item.retired) union.add(item.id);
    if (union.size > MAX_REKEY_LOCK_SET) return err({ code: 'inventory.rekey.lock-set-too-large' });
    const lockedAll = union.size === 0 ? [] : await stock.lockItems(market, [...union]);
    const mine = new Set<string>([...fromVariantIds, ...toVariantIds]);
    const locked = lockedAll.filter((item) => item.offerId === offerId && mine.has(item.variantId));
    if (locked.some((item) => item.sellerId !== sellerId)) {
      return err({ code: 'inventory.rekey.offer-mismatch' });
    }

    const inventory = await inventories.findBySeller(market, sellerId);
    const threshold =
      inventory?.state.lowStockThreshold ?? policies.defaultLowStockThreshold(market);
    const signalOf = (variantId: Id<'Variant'>, sellable: number) =>
      writeSignal(this.deps, context, market, {
        offerId,
        variantId,
        sellerId,
        next: availabilityOf(sellable, threshold),
        now,
      });

    // Tombstones first (events are unordered, ADR-0006): read after the lock, in a new statement.
    const tombstones = await stock.tombstonesOf(market, offerId, toVariantIds);
    const live = locked.filter((item) => !item.retired);
    if (tombstones.offerRetired) {
      // `offer-deleted` came first: only retire what is left, nothing moves.
      await this.retire(
        context,
        live.map((item) => item.id),
        now,
      );
      const variants = [...new Set(live.map((item) => item.variantId))].sort();
      for (const variantId of variants) await signalOf(variantId, 0);
      return ok({
        code: 'inventory.rekeyed',
        sourceItems: live.length,
        sellUnits: variants.length,
      });
    }

    // Step 4: release the live holds, final like `cancelled` (a commit after it is refused). Guarded
    // on `status = 'active'`; one structured line per released reservation.
    const releasedUnits: SellUnitRef[] = [];
    for (const hold of holds) {
      if (!(await reservations.releaseActive(market, hold.state.id, 'offer-moved', now))) continue;
      releasedUnits.push(...hold.state.lines);
      this.#logger.warn({
        msg: 'inventory.rekey.hold-released',
        reservationId: hold.state.id,
        offerId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    // The other sell units of those holds just got stock back: publish their signals (5.3).
    const otherKeys = new Set(otherUnits.map(sellUnitKey));
    await recomputeSellUnitSignals(
      this.deps,
      context,
      market,
      lockedAll,
      releasedUnits.filter((unit) => otherKeys.has(sellUnitKey(unit))),
      now,
    );

    const toRetire: Id<'StockItem'>[] = [];
    let sellUnits = 0;
    for (const [at, from] of fromVariantIds.entries()) {
      const to = toVariantIds[at]!;
      const sources = live.filter((item) => item.variantId === from);
      const targets = locked.filter((item) => item.variantId === to);
      // A retired target without a tombstone cannot happen (retirement always records one); the
      // stock must not vanish into it, so the unit rolls back and the delivery alerts.
      if (!tombstones.retiredVariantIds.has(to) && targets.some((item) => item.retired)) {
        throw new Error('inventory: a retired target stock item has no tombstone');
      }
      const held = await stock.heldQuantities(
        market,
        sources.map((item) => item.id),
        now,
      );
      const created: StockItemRow[] = [];
      for (const source of sources) {
        toRetire.push(source.id);
        if (tombstones.retiredVariantIds.has(to)) {
          // The new Variant was removed already: fail closed, as a removal would.
          this.#logger.warn({
            msg: 'inventory.rekey.stock-dropped',
            offerId,
            fromVariantId: from,
            toVariantId: to,
            sourceId: source.sourceId,
            quantity: source.onHand,
            marketId: market.marketId,
            correlationId: context.correlationId,
          });
          continue;
        }
        const pending = held.get(source.id) ?? 0;
        if (pending > 0) {
          // Committed lines stay on the old item, where fulfil and cancel still work (design 3.6
          // step 4); a live hold would have been released above, so this needs a bug upstream.
          this.#logger.warn({
            msg: 'inventory.rekey.pending-left',
            offerId,
            fromVariantId: from,
            sourceId: source.sourceId,
            quantity: pending,
            marketId: market.marketId,
            correlationId: context.correlationId,
          });
        }
        if (source.onHand - pending < 0) {
          this.#logger.error({
            msg: 'inventory.rekey.pending-exceeds-on-hand',
            offerId,
            fromVariantId: from,
            sourceId: source.sourceId,
            marketId: market.marketId,
            correlationId: context.correlationId,
          });
        }
        const moved = Math.max(0, source.onHand - pending);
        const target = targets.find((item) => item.sourceId === source.sourceId);
        if (target === undefined) {
          const item: StockItemRow = {
            id: ids.next<'StockItem'>(),
            offerId,
            variantId: to,
            sourceId: source.sourceId,
            sellerId,
            onHand: moved,
            retired: false,
            version: 1,
          };
          await stock.insertItem(market, {
            id: item.id,
            offerId,
            variantId: to,
            sourceId: source.sourceId,
            sellerId,
            onHand: moved,
            createdAt: now,
          });
          created.push(item);
        } else {
          // A stock write on the new key got here first: it is the intended total (Hassan M2).
          this.#logger.warn({
            msg: 'inventory.rekey.target-exists',
            offerId,
            toVariantId: to,
            sourceId: source.sourceId,
            moved,
            marketId: market.marketId,
            correlationId: context.correlationId,
          });
        }
        if (moved > 0) {
          // The old item keeps only what stays pending, so its row agrees with the ledger.
          if (
            (await stock.setOnHand(market, source.id, source.version, source.onHand - moved)) ===
            'stale'
          ) {
            throw new Error('inventory: a locked stock item changed under its lock');
          }
          await stock.appendMovement(market, {
            id: ids.next<'StockMovement'>(),
            stockItemId: source.id,
            offerId,
            variantId: from,
            delta: -moved,
            resultingOnHand: source.onHand - moved,
            reason: 're-key',
            correlationId: context.correlationId,
            occurredAt: now,
          });
          if (target === undefined) {
            await stock.appendMovement(market, {
              id: ids.next<'StockMovement'>(),
              stockItemId: created[created.length - 1]!.id,
              offerId,
              variantId: to,
              delta: moved,
              resultingOnHand: moved,
              reason: 're-key',
              correlationId: context.correlationId,
              occurredAt: now,
            });
          }
        }
      }
      // The old Variant never returns (catalog M-1): a write that passed the advisory check before
      // the move cannot re-create its sell unit.
      await stock.recordTombstone(market, {
        id: ids.next<'Retirement'>(),
        target: { scope: 'variant', variantId: from },
        sourceAggregateVersion: input.sourceAggregateVersion,
        retiredAt: now,
      });

      if (sources.length === 0) continue;
      await signalOf(from, 0);
      sellUnits += 1;
      if (!tombstones.retiredVariantIds.has(to)) {
        const kept = targets.filter((item) => !item.retired);
        const heldTo = await stock.heldQuantities(
          market,
          kept.map((item) => item.id),
          now,
        );
        await signalOf(
          to,
          sellableOfSellUnit([
            ...kept.map((item) => ({
              onHand: item.onHand,
              held: heldTo.get(item.id) ?? 0,
              retired: false,
            })),
            ...created.map((item) => ({ onHand: item.onHand, held: 0, retired: false })),
          ]),
        );
        sellUnits += 1;
      }
    }
    await this.retire(context, toRetire, now);
    return ok({ code: 'inventory.rekeyed', sourceItems: toRetire.length, sellUnits });
  }

  private async retire(
    context: CallContext,
    ids: readonly Id<'StockItem'>[],
    now: ReturnType<Clock['now']>,
  ): Promise<void> {
    if (ids.length === 0) return;
    const changed = await this.deps.stock.retireItems(context.market, ids, now);
    // We hold their locks: a different count is a bug, so the unit rolls back.
    if (changed !== ids.length) {
      throw new Error('inventory: a locked stock item was retired under its lock');
    }
  }

  private failed(
    context: CallContext,
    input: RekeyMovedOfferInput,
    code: Extract<RekeyMovedOfferFailure, { code: `inventory.rekey.${string}` }>['code'],
  ): Result<never, RekeyMovedOfferFailure> {
    // An alert: a catalog bug, a forged or stale event, or a lock set over its bound. The delivery
    // takes the platform's failed-delivery path.
    this.#logger.error({
      msg: code,
      offerId: input.offerId,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code });
  }
}

/**
 * Step 1 of the design, before any read: at most the Market's variant cap in pairs, equal lengths,
 * every id distinct across both lists (so no `from` shares an id with a `to`), and the two products
 * differ. Anything else changes nothing.
 */
function validMapping(input: RekeyMovedOfferInput, maxPairs: number): boolean {
  const { fromVariantIds, toVariantIds } = input;
  if (fromVariantIds.length === 0 || fromVariantIds.length !== toVariantIds.length) return false;
  if (fromVariantIds.length > maxPairs) return false;
  if (input.fromProductId === input.toProductId) return false;
  const all = new Set<string>([...fromVariantIds, ...toVariantIds]);
  return all.size === fromVariantIds.length * 2;
}
