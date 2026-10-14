import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { PRICING_PRICE_VIEW } from '../../contracts/permissions';
import type { PriceSeries } from '../../domain/price-series';
import { liveOrScheduledSpecial } from '../../domain/special-price';
import type { PricingPolicyProvider } from '../ports/pricing-policy-provider';
import type { OfferSellUnitsSource } from '../ports/offer-sell-units';
import type { PriceSeriesRepository } from '../ports/price-series.repository';

export interface ViewOfferPricesInput {
  readonly offerId: string;
}

/** The regular price in force: minor units as a string, in the series currency. */
export interface InForcePrice {
  readonly amount: string;
  readonly effectiveFrom: Temporal.Instant;
}

/** A regular price held for review; the previous price stays in force meanwhile. */
export interface HeldPrice {
  readonly amount: string;
  readonly submittedAt: Temporal.Instant;
  readonly direction: 'up' | 'down';
}

/** A special price that runs now or is scheduled; the regular price stays above it. */
export interface SpecialView {
  readonly amount: string;
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant;
  readonly state: 'running' | 'scheduled';
}

/** A special price held for review (a deep discount); nothing changes until it is approved. */
export interface HeldSpecialView {
  readonly amount: string;
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant;
  readonly submittedAt: Temporal.Instant;
}

/** One priceable Variant of the Offer. `seriesVersion` is what the write needs as `expectedVersion`. */
export interface VariantPriceView {
  readonly variantId: Id<'Variant'>;
  /** Null when the Variant has no price yet. */
  readonly seriesVersion: number | null;
  readonly currency: string | null;
  readonly inForce: InForcePrice | null;
  readonly held: HeldPrice | null;
  /** The running or scheduled special, if any. */
  readonly special: SpecialView | null;
  /** The special waiting for review, if any (its window may still end unreviewed). */
  readonly heldSpecial: HeldSpecialView | null;
  /** The series stopped taking prices; read only. */
  readonly retired: boolean;
}

export interface OfferPricesView {
  readonly offerId: Id<'Offer'>;
  /** The Market currency every price is written in. */
  readonly currency: string;
  readonly variants: readonly VariantPriceView[];
}

export type ViewOfferPricesFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'access.denied' }
  /** Unknown, another seller's, another Market's or deleted: one answer. */
  | { readonly code: 'pricing.offer-not-found' };

export interface ViewOfferPricesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly series: PriceSeriesRepository;
  readonly offers: OfferSellUnitsSource;
  readonly policies: PricingPolicyProvider;
  readonly clock: Clock;
}

const NOT_FOUND = Object.freeze({ code: 'pricing.offer-not-found' as const });

/**
 * `pricing.view-offer-prices` (seller panel price page): per priceable Variant of one of the
 * acting seller's Offers, the version the write needs, the regular price in force and a held
 * one. Rule `permissions [pricing.price.view]`, approved sellers only. The Offer is checked like
 * the write: the actor's seller, not deleted; anything else answers `pricing.offer-not-found`.
 * One read-only unit and no write (ADR-0025). Cost is never read.
 */
export class ViewOfferPrices extends UseCase<
  ViewOfferPricesInput,
  OfferPricesView,
  ViewOfferPricesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.view-offer-prices',
    rule: { kind: 'permissions', allOf: [PRICING_PRICE_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('ViewOfferPrices');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ViewOfferPricesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ViewOfferPricesInput,
  ): Promise<Result<OfferPricesView, ViewOfferPricesFailure>> {
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

    const offers = await this.deps.offers.sellUnitsOf(context, [offerId.value]);
    const offer = offers.get(offerId.value);
    if (offer === undefined || offer.sellerId !== actor.sellerId || offer.deleted) {
      this.#logger.log({
        msg: 'pricing.view-offer-prices.refused',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err(NOT_FOUND);
    }

    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.series.findByOffer(market, offerId.value)),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('pricing.view-offer-prices: a read-only unit failed');

    const now = this.deps.clock.now();
    const variants = [...offer.priceableVariantIds]
      .sort()
      .map((variantId) =>
        variantView(
          variantId,
          read.value.find(
            (series) =>
              series.state.variantId === variantId && series.state.sellerId === offer.sellerId,
          ) ?? null,
          now,
        ),
      );
    this.#logger.log({
      msg: 'pricing.view-offer-prices.done',
      variants: variants.length,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({
      offerId: offerId.value,
      currency: this.deps.policies.forOffer(market, offerId.value).currency,
      variants,
    });
  }
}

function variantView(
  variantId: Id<'Variant'>,
  series: PriceSeries | null,
  now: Temporal.Instant,
): VariantPriceView {
  if (series === null) {
    return {
      variantId,
      seriesVersion: null,
      currency: null,
      inForce: null,
      held: null,
      special: null,
      heldSpecial: null,
      retired: false,
    };
  }
  const { regular, specials, currency, retiredAt, version } = series.state;
  const inForce = regular.find(
    (record) =>
      (record.status === 'ACCEPTED' || record.status === 'APPROVED') &&
      record.effectiveFrom !== null &&
      record.effectiveTo === null,
  );
  const pending = regular.find((record) => record.status === 'PENDING_REVIEW');
  const live = liveOrScheduledSpecial(specials, now);
  const waiting = specials.find(
    (record) =>
      record.status === 'PENDING_REVIEW' && Temporal.Instant.compare(record.endsAt, now) > 0,
  );
  return {
    variantId,
    seriesVersion: series.persistedVersion ?? version,
    currency,
    inForce:
      inForce === undefined || inForce.effectiveFrom === null
        ? null
        : { amount: inForce.amount.amount.toString(), effectiveFrom: inForce.effectiveFrom },
    held:
      pending === undefined || pending.heldDirection === null
        ? null
        : {
            amount: pending.amount.amount.toString(),
            submittedAt: pending.submittedAt,
            direction: pending.heldDirection,
          },
    special:
      live === null
        ? null
        : {
            amount: live.amount.amount.toString(),
            startsAt: live.startsAt,
            endsAt: live.endsAt,
            state: Temporal.Instant.compare(live.startsAt, now) <= 0 ? 'running' : 'scheduled',
          },
    heldSpecial:
      waiting === undefined
        ? null
        : {
            amount: waiting.amount.amount.toString(),
            startsAt: waiting.startsAt,
            endsAt: waiting.endsAt,
            submittedAt: waiting.submittedAt,
          },
    retired: retiredAt !== null,
  };
}
