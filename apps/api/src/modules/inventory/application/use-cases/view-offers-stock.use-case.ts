import { Logger } from '@nestjs/common';
import { err, ok, parseIdList } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
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
import type { OfferStockView, StockCellView } from './view-offer-stock.use-case';

/** The most Offers one read takes: the largest page of the seller's Offer list. */
export const MAX_LIST_OFFERS = 100;

export interface ViewOffersStockInput {
  /** Offer ids, comma separated: 1 to {@link MAX_LIST_OFFERS}, each once. */
  readonly offerIds?: unknown;
}

export interface OffersStockView {
  /** Only the asked Offers that are the seller's, not deleted and not retired, in the asked order. */
  readonly offers: readonly OfferStockView[];
}

export type ViewOffersStockFailure =
  ValidationFailed | SellerNotReady | { readonly code: 'access.denied' };

export interface ViewOffersStockDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly inventories: SellerInventoryRepository;
  readonly offerStock: OfferStockReader;
  readonly offers: OfferSellUnitsSource;
  readonly clock: Clock;
}

/**
 * `inventory.view-offers-stock` (seller Offer list, Offer page PR 8): the stock of a page of the
 * acting seller's Offers in one read, each Offer exactly as `inventory.view-offer-stock` answers
 * it (one cell per sell unit and location, with the level, the held quantity and the version the
 * write needs). An asked Offer that is not the seller's, is deleted, retired or unknown is left
 * out, so the answer never tells one from another. One read-only unit, three statements (the held
 * quantities split into one more per 1,000 stock items), and no write (ADR-0025).
 */
export class ViewOffersStock extends UseCase<
  ViewOffersStockInput,
  OffersStockView,
  ViewOffersStockFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.view-offers-stock',
    rule: { kind: 'permissions', allOf: [INVENTORY_STOCK_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('ViewOffersStock');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ViewOffersStockDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ViewOffersStockInput,
  ): Promise<Result<OffersStockView, ViewOffersStockFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const asked = parseIdList<'Offer'>(input?.offerIds, MAX_LIST_OFFERS);
    if (asked === null) return validationFailed([{ path: 'offerIds', code: 'format' }]);

    const found = await this.deps.offers.sellUnitsOf(context, asked);
    const own = asked.flatMap((offerId) => {
      const offer = found.get(offerId);
      return offer === undefined || offer.sellerId !== sellerId || offer.deleted
        ? []
        : [{ offerId, variantIds: [...offer.sellUnitVariantIds].sort() }];
    });

    const { market } = context;
    const now = this.deps.clock.now();
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const inventory = await this.deps.inventories.findBySeller(market, sellerId);
        if (inventory === null) return ok(null);
        const snapshots = await this.deps.offerStock.readMany(market, sellerId, own, now);
        return ok({ inventory, snapshots });
      },
      { readOnly: true },
    );
    if (!read.ok) throw new Error('inventory.view-offers-stock: a read-only unit failed');
    if (read.value === null) {
      this.#logger.log({
        msg: 'inventory.view-offers-stock.refused',
        code: NOT_READY.code,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err(NOT_READY);
    }
    const { inventory, snapshots } = read.value;
    const sources = [...inventory.state.sources].sort((a, b) => a.priority - b.priority);

    const offers = own.flatMap(({ offerId, variantIds }): OfferStockView[] => {
      const snapshot = snapshots.get(offerId);
      if (snapshot === undefined || snapshot.offerRetired) return [];
      return [
        {
          offerId,
          variants: variantIds
            .filter((variantId) => !snapshot.retiredVariantIds.has(variantId))
            .map((variantId) => ({
              variantId,
              sources: sources.map((source): StockCellView => {
                const item = snapshot.items.find(
                  (candidate) =>
                    candidate.variantId === variantId && candidate.sourceId === source.id,
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
            })),
        },
      ];
    });
    this.#logger.log({
      msg: 'inventory.view-offers-stock.done',
      asked: asked.length,
      offers: offers.length,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({ offers });
  }
}
