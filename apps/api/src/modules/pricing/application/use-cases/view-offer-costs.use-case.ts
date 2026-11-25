import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { PRICING_COST_VIEW } from '../../contracts/permissions';
import type { CostAmount } from '../../domain/cost/cost-amount';
import { isActingAsSession } from '../acting-as';
import type { CostSeriesRepository } from '../ports/cost-series.repository';
import type { OfferSellUnitsSource } from '../ports/offer-sell-units';
import type { PricingPolicyProvider } from '../ports/pricing-policy-provider';

export interface ViewOfferCostsInput {
  readonly offerId: string;
}

/** The Cost of one priceable Variant. `cost` stays a {@link CostAmount} until the presenter. */
export interface VariantCostView {
  readonly variantId: Id<'Variant'>;
  /** What the Cost write needs as `expectedVersion`; null when no Cost was ever recorded. */
  readonly seriesVersion: number | null;
  /** The current Cost, or null when none is recorded (or it was cleared). */
  readonly cost: CostAmount | null;
}

export interface OfferCostsView {
  readonly offerId: Id<'Offer'>;
  /** The Market currency every Cost is written in. */
  readonly currency: string;
  readonly variants: readonly VariantCostView[];
}

export type ViewOfferCostsFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'access.denied' }
  /** Refused in a Login as Seller session (design 5.4; Hassan finding 6). */
  | { readonly code: 'pricing.acting-as-refused' }
  /** Unknown, another seller's, another Market's or deleted: one answer. */
  | { readonly code: 'pricing.offer-not-found' };

export interface ViewOfferCostsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly costs: CostSeriesRepository;
  readonly offers: OfferSellUnitsSource;
  readonly policies: PricingPolicyProvider;
}

const NOT_FOUND = Object.freeze({ code: 'pricing.offer-not-found' as const });

/**
 * `pricing.view-cost` (pricing design 5.2, 6.5; ux F41 step 2): the current Cost of every
 * priceable Variant of one of the acting seller's Offers. Rule `permissions
 * [pricing.cost.view]` (design 5.2), approved sellers only; refused in an acting-as session
 * (design 5.4). The Offer is checked like a price write: the actor's seller, not deleted;
 * anything else answers `pricing.offer-not-found`. One read-only unit (ADR-0025), and only the
 * Cost tables are read: no price is loaded next to a Cost. Logs carry ids, codes and counts only.
 */
export class ViewOfferCosts extends UseCase<
  ViewOfferCostsInput,
  OfferCostsView,
  ViewOfferCostsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.view-cost',
    rule: { kind: 'permissions', allOf: [PRICING_COST_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('ViewOfferCosts');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ViewOfferCostsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ViewOfferCostsInput,
  ): Promise<Result<OfferCostsView, ViewOfferCostsFailure>> {
    const { actor, market } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    if (isActingAsSession(actor)) {
      this.log('pricing.view-cost.acting-as-refused', context, {});
      return err({ code: 'pricing.acting-as-refused' });
    }
    const offerId = parseId<'Offer'>(input?.offerId);
    if (!offerId.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'offerId', code: 'format' }] });
    }

    const offers = await this.deps.offers.sellUnitsOf(context, [offerId.value]);
    const offer = offers.get(offerId.value);
    if (offer === undefined || offer.sellerId !== actor.sellerId || offer.deleted) {
      this.log('pricing.view-cost.refused', context, {});
      return err(NOT_FOUND);
    }

    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.costs.findByOffer(market, offerId.value)),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('pricing.view-cost: a read-only unit failed');

    const variants = [...offer.priceableVariantIds].sort().map((variantId): VariantCostView => {
      // A series is read only when its seller copy is the seller catalog names (Hassan L3).
      const series = read.value.find(
        (found) => found.state.variantId === variantId && found.state.sellerId === offer.sellerId,
      );
      return series === undefined
        ? { variantId, seriesVersion: null, cost: null }
        : { variantId, seriesVersion: series.persistedVersion, cost: series.current };
    });
    this.log('pricing.view-cost.done', context, {
      offerId: offerId.value,
      variants: variants.length,
    });
    return ok({
      offerId: offerId.value,
      currency: this.deps.policies.forOffer(market, offerId.value).currency,
      variants,
    });
  }

  /** Ids, codes and counts only: never a Cost (design 6.5; Hassan finding 5). */
  private log(msg: string, context: CallContext, fields: Record<string, string | number>): void {
    const actor = context.actor;
    this.#logger.log({
      msg,
      ...fields,
      ...(actor.kind === 'authenticated' ? { accountId: actor.accountId } : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
