import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PRICING_PRICE_VIEW } from '../../contracts/permissions';
import { typicalRange } from '../../domain/typical-range';
import { TYPICAL_PRICE_LIMITS, TYPICAL_PRICE_SELLER_LIMITS } from '../../domain/write-rate-limits';
import { gatherVariantReference, referenceFor } from '../reference/variant-reference';
import type { VariantReferenceDependencies } from '../reference/variant-reference';
import { reserveWriteAllowance, type WriteAllowanceDependencies } from '../write-allowance';
import type { WriteThrottled } from '../write-allowance';

export interface ViewTypicalPricesInput {
  readonly offerId: string;
}

/**
 * One priceable Variant of the Offer. `range` is only a span of minor units of the Market currency
 * (never the median, never a seller's price), and only when enough independent businesses sell
 * the Variant. No reason is given for its absence: fewer businesses, an unreadable reference and a
 * Variant nobody sells all read the same, so the count of other sellers is never shown.
 */
export interface VariantTypicalPriceView {
  readonly variantId: Id<'Variant'>;
  readonly range: { readonly lowMinor: string; readonly highMinor: string } | null;
}

export interface TypicalPricesView {
  readonly offerId: Id<'Offer'>;
  readonly variants: readonly VariantTypicalPriceView[];
}

export type ViewTypicalPricesFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'access.denied' }
  /** Unknown, another seller's, another Market's or deleted: one answer. */
  | { readonly code: 'pricing.offer-not-found' }
  | WriteThrottled;

export type ViewTypicalPricesDependencies = VariantReferenceDependencies &
  WriteAllowanceDependencies;

const NOT_FOUND = Object.freeze({ code: 'pricing.offer-not-found' as const });

/** An Offer carries a handful of Variants; more than this is not read (the rest show no range). */
const MAX_VARIANTS = 20;

/**
 * `pricing.view-typical-prices` (offer page, "Typical price"): per priceable Variant of one of the
 * acting seller's Offers, the range other businesses sell it in, from the reference of R4
 * (ADR-0051): the median of the regular prices of the other live Offers, one vote per business,
 * needing `referenceSellers` distinct businesses. Rule `permissions [pricing.price.view]`,
 * approved sellers only. The seller's own Offers never count.
 *
 * What the answer leaks is bounded on purpose (Hassan, design 9): only a range widened outward to
 * two significant digits, never the exact median, no seller, no Offer, no count of businesses, and
 * a per-account read cap that is counted before the Offer lookup. Nothing is written except that
 * counter; cost is never read.
 */
export class ViewTypicalPrices extends UseCase<
  ViewTypicalPricesInput,
  TypicalPricesView,
  ViewTypicalPricesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.view-typical-prices',
    rule: { kind: 'permissions', allOf: [PRICING_PRICE_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('ViewTypicalPrices');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ViewTypicalPricesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ViewTypicalPricesInput,
  ): Promise<Result<TypicalPricesView, ViewTypicalPricesFailure>> {
    const { actor, market } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    const offerId = parseId<'Offer'>(input?.offerId);
    if (!offerId.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'offerId', code: 'format' }] });
    }

    const allowed = await reserveWriteAllowance(
      this.deps,
      context,
      actor.accountId,
      TYPICAL_PRICE_LIMITS,
    );
    if (!allowed.ok)
      return this.#throttled(context, actor.sellerId, actor.accountId, allowed.error);
    // The same reads per seller over all its accounts; the key column holds the seller id.
    const sellerAllowed = await reserveWriteAllowance(
      this.deps,
      context,
      actor.sellerId as unknown as Id<'Account'>,
      TYPICAL_PRICE_SELLER_LIMITS,
    );
    if (!sellerAllowed.ok) {
      return this.#throttled(context, actor.sellerId, actor.accountId, sellerAllowed.error);
    }

    const offers = await this.deps.offers.sellUnitsOf(context, [offerId.value]);
    const offer = offers.get(offerId.value);
    if (offer === undefined || offer.sellerId !== actor.sellerId || offer.deleted) {
      this.#logger.log({
        msg: 'pricing.view-typical-prices.refused',
        sellerId: actor.sellerId,
        accountId: actor.accountId,
        offerId: offerId.value,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err(NOT_FOUND);
    }

    const variants: VariantTypicalPriceView[] = [];
    let measured = 0;
    for (const variantId of [...offer.priceableVariantIds].sort()) {
      if (measured >= MAX_VARIANTS) {
        variants.push({ variantId, range: null });
        continue;
      }
      measured += 1;
      const gathered = await gatherVariantReference(this.deps, context, {
        productId: offer.productId,
        variantId,
      });
      const reference = referenceFor(gathered, offer.sellerId);
      variants.push({
        variantId,
        range:
          reference.kind === 'reference'
            ? rangeBody(typicalRange(reference.reference, reference.bandPercent))
            : null,
      });
    }
    this.#logger.log({
      msg: 'pricing.view-typical-prices.done',
      sellerId: actor.sellerId,
      accountId: actor.accountId,
      offerId: offerId.value,
      variants: variants.length,
      withRange: variants.filter((v) => v.range !== null).length,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({ offerId: offerId.value, variants });
  }

  /** A refused read is logged with who asked (never a price), so probing can be traced. */
  #throttled(
    context: CallContext,
    sellerId: Id<'Seller'>,
    accountId: Id<'Account'>,
    refusal: WriteThrottled,
  ): Result<never, WriteThrottled> {
    this.#logger.warn({
      msg: 'pricing.view-typical-prices.throttled',
      sellerId,
      accountId,
      retryAfterSeconds: refusal.retryAfterSeconds,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err(refusal);
  }
}

function rangeBody(range: { lowMinor: bigint; highMinor: bigint }) {
  return { lowMinor: range.lowMinor.toString(), highMinor: range.highMinor.toString() };
}
