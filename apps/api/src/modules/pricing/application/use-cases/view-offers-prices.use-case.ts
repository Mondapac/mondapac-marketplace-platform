import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { PRICING_PRICE_VIEW } from '../../contracts/permissions';
import type { PricingPolicyProvider } from '../ports/pricing-policy-provider';
import type { OfferSellUnitsSource } from '../ports/offer-sell-units';
import type { PriceSeriesRepository } from '../ports/price-series.repository';
import { variantView, type VariantPriceView } from './view-offer-prices.use-case';

/** The most Offers one read takes: the largest page of the seller's Offer list. */
export const MAX_LIST_OFFERS = 100;

export interface ViewOffersPricesInput {
  /** Offer ids, comma separated: 1 to {@link MAX_LIST_OFFERS}, each once. */
  readonly offerIds?: unknown;
}

/** One of the asked Offers that is the seller's own: its priceable Variants, as the price page. */
export interface ListOfferPrices {
  readonly offerId: Id<'Offer'>;
  readonly variants: readonly VariantPriceView[];
}

export interface OffersPricesView {
  /** The Market currency every price is written in. */
  readonly currency: string;
  /** Only the asked Offers that are the seller's and not deleted, in the asked order. */
  readonly offers: readonly ListOfferPrices[];
}

export type ViewOffersPricesFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'access.denied' };

export interface ViewOffersPricesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly series: PriceSeriesRepository;
  readonly offers: OfferSellUnitsSource;
  readonly policies: PricingPolicyProvider;
  readonly clock: Clock;
}

/**
 * `pricing.view-offers-prices` (seller Offer list, Offer page PR 8): the prices of a page of the
 * acting seller's Offers in one read, each Offer exactly as `pricing.view-offer-prices` answers
 * it. Rule `permissions [pricing.price.view]`, approved sellers only. An asked Offer that is not
 * the seller's, is deleted or is unknown is left out of the answer, so the answer never tells one
 * from another. One read-only unit and no write (ADR-0025). Cost is never read.
 */
export class ViewOffersPrices extends UseCase<
  ViewOffersPricesInput,
  OffersPricesView,
  ViewOffersPricesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.view-offers-prices',
    rule: { kind: 'permissions', allOf: [PRICING_PRICE_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('ViewOffersPrices');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ViewOffersPricesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ViewOffersPricesInput,
  ): Promise<Result<OffersPricesView, ViewOffersPricesFailure>> {
    const { actor, market } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    const asked = parseOfferIds(input?.offerIds, MAX_LIST_OFFERS);
    if (asked === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'offerIds', code: 'format' }] });
    }

    const found = await this.deps.offers.sellUnitsOf(context, asked);
    const own = asked.flatMap((offerId) => {
      const offer = found.get(offerId);
      return offer === undefined || offer.sellerId !== actor.sellerId || offer.deleted
        ? []
        : [{ offerId, offer }];
    });

    const read = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(
          own.length === 0
            ? []
            : await this.deps.series.findByOffers(
                market,
                own.map((item) => item.offerId),
              ),
        ),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('pricing.view-offers-prices: a read-only unit failed');

    const now = this.deps.clock.now();
    const offers = own.map(({ offerId, offer }) => ({
      offerId,
      variants: [...offer.priceableVariantIds]
        .sort()
        .map((variantId) =>
          variantView(
            variantId,
            read.value.find(
              (series) =>
                series.state.offerId === offerId &&
                series.state.variantId === variantId &&
                series.state.sellerId === offer.sellerId,
            ) ?? null,
            now,
          ),
        ),
    }));
    this.#logger.log({
      msg: 'pricing.view-offers-prices.done',
      asked: asked.length,
      offers: offers.length,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({ currency: this.deps.policies.forMarket(market).currency, offers });
  }
}

/** Comma-separated Offer ids: 1 to `max`, each a UUID and each once. Null for anything else. */
export function parseOfferIds(text: unknown, max: number): readonly Id<'Offer'>[] | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > max * 37) return null;
  const parts = text.split(',');
  if (parts.length > max) return null;
  const ids: Id<'Offer'>[] = [];
  for (const part of parts) {
    const id = parseId<'Offer'>(part);
    if (!id.ok || ids.includes(id.value)) return null;
    ids.push(id.value);
  }
  return ids;
}
