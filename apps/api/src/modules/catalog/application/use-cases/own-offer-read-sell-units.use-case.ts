import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import { sellUnitKey } from '../../contracts/catalog.facade';
import { sellUnitDisplaySku } from '../../domain/offer-sell-unit';
import { variantCodeOf } from '../../domain/product';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferRepository } from '../ports/offer.repository';
import type { OfferSellUnitsReader } from '../ports/offer-sell-units.reader';
import type { ProductSellUnitFactsReader } from '../ports/product-sell-unit-facts.reader';
import type { SellUnitLabelsReader } from '../ports/sell-unit-labels.reader';
import { invalid, sellerOf, type ValidationFailure } from '../own-reads/own-reads.shared';

export interface OwnOfferReadSellUnitsInput {
  readonly offerId: string;
}

export interface OwnOfferSellUnitView {
  readonly variantId: string;
  readonly variantNo: number;
  readonly variantCode: string;
  readonly state: 'proposed' | 'published';
  /** The published variant label in the Market's default locale, else null. */
  readonly label: string | null;
  readonly selling: boolean;
  readonly variantSku: string | null;
  /** The SKU exports and invoices show: the variant SKU, else `{sellerSku}-{variantNo}`. */
  readonly displaySku: string;
}

export interface OwnOfferSellUnitsView {
  readonly productScope: 'PLATFORM' | 'SELLER';
  readonly sellerSku: string;
  readonly units: readonly OwnOfferSellUnitView[];
}

export type OwnOfferReadSellUnitsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'offer.not-found' }
  | ValidationFailure;

export interface OwnOfferReadSellUnitsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly reader: OfferSellUnitsReader;
  readonly labelsReader: SellUnitLabelsReader;
  readonly productSellUnitFacts: ProductSellUnitFactsReader;
  readonly policy: CatalogMarketPolicy;
}

/**
 * `own-offer.read-sell-units` (variants V5): the current SKU and "selling" switch of each
 * non-retired sell unit of one of the seller's own Offers, with the unit's code and published
 * label, so the seller panel can show and edit them. Rule: the key `catalog.own-product.view` and
 * the seller population. An unknown Offer, another seller's and a deleted one answer one
 * byte-identical `offer.not-found`. One read-only unit (ADR-0025).
 */
export class OwnOfferReadSellUnits extends UseCase<
  OwnOfferReadSellUnitsInput,
  OwnOfferSellUnitsView,
  OwnOfferReadSellUnitsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offer-read-sell-units',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOfferReadSellUnitsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferReadSellUnitsInput,
  ): Promise<Result<OwnOfferSellUnitsView, OwnOfferReadSellUnitsFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const parsed = typeof input.offerId === 'string' ? parseId<'Offer'>(input.offerId) : null;
    if (parsed === null || !parsed.ok) return invalid('offerId', 'format');
    const { market } = context;
    const offerId = parsed.value;
    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const read = await this.deps.unitOfWork.run<
      OwnOfferSellUnitsView | null,
      OwnOfferReadSellUnitsFailure
    >(
      market,
      async () => {
        const offer = await this.deps.offers.findById(market, offerId);
        if (offer === null) return ok(null);
        const { sellerId: owner, status, productId, sellerSku } = offer.state;
        if (owner !== sellerId || status === 'deleted') return ok(null);
        const [units, facts] = await Promise.all([
          this.deps.reader.read(market, [offerId]),
          this.deps.productSellUnitFacts.read(market, productId),
        ]);
        const own = units.get(offerId);
        if (own === undefined || facts === null) return ok(null);
        const numbers = new Map(facts.variants.map((v) => [v.variantId as string, v.variantNo]));
        const labels = await this.deps.labelsReader.read(
          market,
          own.sellUnits.map((unit) => ({ offerId, variantId: unit.variantId })),
          locale,
        );
        const rows = own.sellUnits
          .flatMap((unit) => {
            const variantNo = numbers.get(unit.variantId);
            return variantNo === undefined ? [] : [{ unit, variantNo }];
          })
          .sort((a, b) => a.variantNo - b.variantNo)
          .map(({ unit, variantNo }) => ({
            variantId: unit.variantId,
            variantNo,
            variantCode: variantCodeOf(facts.productCode, variantNo),
            state: unit.state,
            label:
              labels.get(sellUnitKey({ offerId, variantId: unit.variantId }))?.variantLabel ?? null,
            selling: unit.selling,
            variantSku: unit.variantSku,
            displaySku: sellUnitDisplaySku({
              sellerSku,
              variantSku: unit.variantSku,
              variantNo,
            }),
          }));
        return ok({ productScope: facts.scope, sellerSku, units: rows });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return read.value === null ? err({ code: 'offer.not-found' }) : ok(read.value);
  }
}
