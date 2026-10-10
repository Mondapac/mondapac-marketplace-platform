import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { INVENTORY_STOCK_VIEW } from '../../contracts/permissions';
import type { OfferSellUnitsSource } from '../ports/offer-sell-units';
import type { OfferStockReader } from '../ports/offer-stock.reader';
import type { SellerInventoryRepository } from '../ports/seller-inventory.repository';
import {
  NOT_READY,
  sellerOf,
  validationFailed,
  type SellerNotReady,
  type ValidationFailed,
} from '../source-use-case-support';

export interface ViewOfferStockInput {
  readonly offerId: string;
}

/** One Variant at one of the seller's locations. */
export interface StockCellView {
  readonly variantId: Id<'Variant'>;
  readonly sourceId: Id<'InventorySource'>;
  /** 0 when the location has no item yet. */
  readonly onHand: number;
  /** Units held by ACTIVE unexpired and COMMITTED reservation lines; exact for the owner. */
  readonly held: number;
  /** What `set-stock-level` needs as `expectedVersion`; null when there is no item yet. */
  readonly version: number | null;
  readonly retired: boolean;
}

export interface OfferStockView {
  readonly offerId: Id<'Offer'>;
  readonly variants: readonly {
    readonly variantId: Id<'Variant'>;
    readonly sources: readonly StockCellView[];
  }[];
}

export type ViewOfferStockFailure =
  | ValidationFailed
  | SellerNotReady
  | { readonly code: 'access.denied' }
  /** Unknown, another seller's, another Market's, deleted or retired: all one answer (AC 11). */
  | { readonly code: 'inventory.not-found' };

export interface ViewOfferStockDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly inventories: SellerInventoryRepository;
  readonly offerStock: OfferStockReader;
  readonly offers: OfferSellUnitsSource;
  readonly clock: Clock;
}

const NOT_FOUND = Object.freeze({ code: 'inventory.not-found' as const });

/**
 * `inventory.view-offer-stock` (seller panel stock page): per sell unit of one of the acting
 * seller's Offers, one cell per stock location of the seller, with the level, the held quantity
 * and the item version the write needs. The Offer is checked like `set-stock-level` (the actor's
 * seller, not deleted; anything else answers `inventory.not-found`). Every non-retired Variant
 * catalog lists appears, with 0 and a null version where no item exists. Read-only: one
 * read-only unit and no write (ADR-0025). Held counts are exact: the reader is the seller.
 */
export class ViewOfferStock extends UseCase<
  ViewOfferStockInput,
  OfferStockView,
  ViewOfferStockFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.view-offer-stock',
    rule: { kind: 'permissions', allOf: [INVENTORY_STOCK_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('ViewOfferStock');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ViewOfferStockDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ViewOfferStockInput,
  ): Promise<Result<OfferStockView, ViewOfferStockFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const offerId = parseId<'Offer'>(input?.offerId);
    if (!offerId.ok) return validationFailed([{ path: 'offerId', code: 'format' }]);

    const offers = await this.deps.offers.sellUnitsOf(context, [offerId.value]);
    const offer = offers.get(offerId.value);
    if (offer === undefined || offer.sellerId !== sellerId || offer.deleted) {
      return this.refused(context, NOT_FOUND);
    }
    const variantIds = [...offer.sellUnitVariantIds].sort();

    const { market } = context;
    const now = this.deps.clock.now();
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const inventory = await this.deps.inventories.findBySeller(market, sellerId);
        if (inventory === null) return ok(null);
        const snapshot = await this.deps.offerStock.read(
          market,
          sellerId,
          offerId.value,
          variantIds,
          now,
        );
        return ok({ inventory, snapshot });
      },
      { readOnly: true },
    );
    if (!read.ok) throw new Error('inventory.view-offer-stock: a read-only unit failed');
    if (read.value === null) return this.refused(context, NOT_READY);
    const { inventory, snapshot } = read.value;
    if (snapshot.offerRetired) return this.refused(context, NOT_FOUND);

    const sources = [...inventory.state.sources].sort((a, b) => a.priority - b.priority);
    const variants = variantIds
      .filter((variantId) => !snapshot.retiredVariantIds.has(variantId))
      .map((variantId) => ({
        variantId,
        sources: sources.map((source): StockCellView => {
          const item = snapshot.items.find(
            (candidate) => candidate.variantId === variantId && candidate.sourceId === source.id,
          );
          return {
            variantId,
            sourceId: source.id,
            onHand: item?.onHand ?? 0,
            held: item?.held ?? 0,
            version: item?.version ?? null,
            retired: item?.retired ?? false,
          };
        }),
      }));
    this.#logger.log({
      msg: 'inventory.view-offer-stock.done',
      variants: variants.length,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({ offerId: offerId.value, variants });
  }

  private refused(
    context: CallContext,
    failure: SellerNotReady | { readonly code: 'inventory.not-found' },
  ): Result<never, ViewOfferStockFailure> {
    this.#logger.log({
      msg: 'inventory.view-offer-stock.refused',
      code: failure.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err(failure);
  }
}
