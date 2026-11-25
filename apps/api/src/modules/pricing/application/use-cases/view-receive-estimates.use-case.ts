import { Logger } from '@nestjs/common';
import { err, ok, parseId, parseMinorUnits } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_EARNINGS_VIEW } from '../../../commission-payouts';
import { PRICING_PRICE_VIEW } from '../../contracts/permissions';
import { isActingAsSession } from '../acting-as';
import type { OfferSellUnitsSource } from '../ports/offer-sell-units';
import type { OwnCommissionSource } from '../ports/own-commission';
import type { PricingPolicyProvider } from '../ports/pricing-policy-provider';

export interface ViewReceiveEstimatesInput {
  readonly offerId?: unknown;
  /** `variantId:priceMinor` pairs, comma separated: the prices the seller sees or has typed. */
  readonly lines?: unknown;
}

/** What the seller receives for one unit of one Variant at one price, as the ledger will post it. */
export interface ReceiveEstimateLine {
  readonly variantId: Id<'Variant'>;
  /** The price asked about, minor units as a string: what the customer pays for one unit. */
  readonly priceMinor: string;
  /** The most the commission can be on that price (a lower exclusive-customer rate only lowers it). */
  readonly commissionMinor: string;
  /** `priceMinor − commissionMinor`: what the ledger credits, before delivery. */
  readonly youReceiveMinor: string;
}

export interface ReceiveEstimatesView {
  readonly offerId: Id<'Offer'>;
  readonly currency: string;
  /** The Market's price convention: true when the prices, and so `youReceiveMinor`, include tax. */
  readonly taxInclusive: boolean;
  readonly lines: readonly ReceiveEstimateLine[];
}

export type ViewReceiveEstimatesFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'access.denied' }
  /** Unknown, another seller's, another Market's or deleted: one answer. */
  | { readonly code: 'pricing.offer-not-found' }
  /** Login as Seller: the seller's own commission is not read for someone acting as it. */
  | { readonly code: 'pricing.acting-as-refused' }
  /** The product has no published tax category yet, so no line of it can be priced at checkout. */
  | { readonly code: 'pricing.estimate-no-tax-category' }
  /** The Offer, the tax rate or the commission cannot be read now: no money is guessed. */
  | { readonly code: 'pricing.estimate-unavailable' };

export interface ViewReceiveEstimatesDependencies {
  readonly offers: OfferSellUnitsSource;
  readonly policies: PricingPolicyProvider;
  readonly ownCommission: OwnCommissionSource;
}

/** An Offer carries a handful of Variants; a longer list is refused whole. */
export const MAX_ESTIMATE_LINES = 20;
/** The largest price asked about (`ownCommissionOn` takes amounts up to 10^12). */
const MAX_PRICE = 10n ** 12n;

const NOT_FOUND = Object.freeze({ code: 'pricing.offer-not-found' as const });
const UNAVAILABLE = Object.freeze({ code: 'pricing.estimate-unavailable' as const });

/**
 * `pricing.view-receive-estimates` (Offer page PR 4, "You receive (est.)"): for prices of the
 * Variants of one of the acting seller's own Offers, the commission and what the seller receives
 * for one unit, worked out by `commission-payouts` exactly as the ledger will (the seller's own
 * rate, the line's tax rate from the Offer's published tax category, the ledger's rounding).
 * The prices come from the request because the page shows the estimate while the seller types;
 * nothing is saved and nothing is written. Promotions are not counted.
 *
 * Rule `permissions [pricing.price.view, commission-payouts.earnings.view]`: the commission is
 * the seller's financial data, so the key of the seller ledger is needed as well (as reporting's
 * net earnings). Approved sellers only. The Offer is checked like the price write: the actor's
 * seller, not deleted, every Variant priceable on it; anything else is `pricing.offer-not-found`.
 * The rate itself is never answered, and an unreadable value is `pricing.estimate-unavailable`.
 * An acting-as (Login as Seller) session is refused first (`pricing.acting-as-refused`), as the
 * Cost reads are: `ownCommissionOn` refuses it too, and it must not look like an outage. The rate
 * is read once per request; every amount then goes through the ledger's own rule.
 */
export class ViewReceiveEstimates extends UseCase<
  ViewReceiveEstimatesInput,
  ReceiveEstimatesView,
  ViewReceiveEstimatesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.view-receive-estimates',
    rule: {
      kind: 'permissions',
      allOf: [PRICING_PRICE_VIEW.key, COMMISSION_PAYOUTS_EARNINGS_VIEW.key],
    },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('ViewReceiveEstimates');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ViewReceiveEstimatesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ViewReceiveEstimatesInput,
  ): Promise<Result<ReceiveEstimatesView, ViewReceiveEstimatesFailure>> {
    const { actor, market } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    if (isActingAsSession(actor)) {
      this.#logger.log({
        msg: 'pricing.view-receive-estimates.acting-as-refused',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'pricing.acting-as-refused' });
    }
    const offerId = parseId<'Offer'>(typeof input?.offerId === 'string' ? input.offerId : '');
    if (!offerId.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'offerId', code: 'format' }] });
    }
    const asked = parseLines(input?.lines);
    if (asked === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'lines', code: 'format' }] });
    }

    let offers: Awaited<ReturnType<OfferSellUnitsSource['sellUnitsOf']>>;
    try {
      offers = await this.deps.offers.sellUnitsOf(context, [offerId.value]);
    } catch {
      return this.#unavailable(context, 'offer');
    }
    const offer = offers.get(offerId.value);
    if (
      offer === undefined ||
      offer.sellerId !== actor.sellerId ||
      offer.deleted ||
      asked.some((line) => !offer.priceableVariantIds.has(line.variantId))
    ) {
      this.#logger.log({
        msg: 'pricing.view-receive-estimates.refused',
        sellerId: actor.sellerId,
        accountId: actor.accountId,
        offerId: offerId.value,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err(NOT_FOUND);
    }

    const taxInclusive = this.deps.policies.pricesIncludeTax(market);
    const taxRateBps = await this.deps.ownCommission.lineTaxRate(context, offerId.value);
    if (taxRateBps === null) return this.#unavailable(context, 'tax-rate');
    if (taxRateBps === 'no-category') return err({ code: 'pricing.estimate-no-tax-category' });
    const answers = await this.deps.ownCommission.commissionsOn(
      context,
      asked.map((line) => line.price),
      taxInclusive,
      taxRateBps,
    );
    if (answers === null || answers.length !== asked.length) {
      return this.#unavailable(context, 'commission');
    }
    const lines: ReceiveEstimateLine[] = asked.map((line, index) => {
      const answer = answers[index] as (typeof answers)[number];
      return {
        variantId: line.variantId,
        priceMinor: line.price.toString(),
        commissionMinor: answer.commission.toString(),
        youReceiveMinor: answer.sellerReceives.toString(),
      };
    });
    this.#logger.log({
      msg: 'pricing.view-receive-estimates.done',
      lines: lines.length,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({
      offerId: offerId.value,
      currency: this.deps.policies.forOffer(market, offerId.value).currency,
      taxInclusive,
      lines,
    });
  }

  #unavailable(
    context: CallContext,
    part: 'offer' | 'tax-rate' | 'commission',
  ): Result<never, ViewReceiveEstimatesFailure> {
    this.#logger.warn({
      msg: 'pricing.view-receive-estimates.unavailable',
      part,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err(UNAVAILABLE);
  }
}

/**
 * `variantId:priceMinor` pairs, comma separated: 1 to {@link MAX_ESTIMATE_LINES}, each Variant
 * once, each price 1 to 10^12 minor units. Null for anything else.
 */
function parseLines(
  text: unknown,
): readonly { readonly variantId: Id<'Variant'>; readonly price: bigint }[] | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 2000) return null;
  const parts = text.split(',');
  if (parts.length > MAX_ESTIMATE_LINES) return null;
  const lines: { variantId: Id<'Variant'>; price: bigint }[] = [];
  for (const part of parts) {
    const [idText, priceText, extra] = part.split(':');
    if (extra !== undefined) return null;
    const variantId = parseId<'Variant'>(idText ?? '');
    const price = parseMinorUnits(priceText);
    if (!variantId.ok || !price.ok || price.value < 1n || price.value > MAX_PRICE) return null;
    if (lines.some((line) => line.variantId === variantId.value)) return null;
    lines.push({ variantId: variantId.value, price: price.value });
  }
  return lines;
}
