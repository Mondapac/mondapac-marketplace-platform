import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { PRICING_COST_VIEW, PRICING_PRICE_EDIT } from '../../contracts/permissions';
import { CostCleared, CostSet, type OfferWriteRefusalCause } from '../../domain/audit';
import { costAmount, type CostAmount } from '../../domain/cost/cost-amount';
import { CostSeries } from '../../domain/cost/cost-series';
import { isActingAsSession } from '../acting-as';
import type { CostSeriesRepository } from '../ports/cost-series.repository';
import type { OfferSellUnitsSource, PricedOfferView } from '../ports/offer-sell-units';
import type { PricingPolicyProvider } from '../ports/pricing-policy-provider';
import type { WriteRefusalThrottleRepository } from '../ports/write-refusal-throttle.repository';
import { recordOfferWriteRefusal } from '../refusals/offer-write-refusal';
import { runSerializable } from '../serializable-unit';
import {
  reserveWriteAllowance,
  type WriteAllowanceDependencies,
  type WriteThrottled,
} from '../write-allowance';
import { refusalCause } from './set-regular-price.use-case';

/** Input as the route passes it: the amount is a string of minor units; null clears the Cost. */
export interface SetOfferCostInput {
  readonly offerId: string;
  readonly variantId: string;
  readonly cost: { readonly amount: string; readonly currency: string } | null;
  /** The Cost series version the screen showed, or null when it showed no Cost series. */
  readonly expectedVersion: number | null;
}

export interface SetOfferCostOutput {
  /** `unchanged`: the Cost was already this value (or already none); nothing was written. */
  readonly status: 'recorded' | 'cleared' | 'unchanged';
  /** The series version after the write; null when no series exists (clearing "none"). */
  readonly seriesVersion: number | null;
}

export type SetOfferCostFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'access.denied' }
  | { readonly code: 'pricing.acting-as-refused' }
  | { readonly code: 'pricing.offer-not-found' }
  | { readonly code: 'pricing.currency-mismatch' }
  | { readonly code: 'pricing.amount-out-of-range' }
  | { readonly code: 'pricing.series-retired' }
  | { readonly code: 'conflict.stale' }
  | WriteThrottled;

export interface SetOfferCostDependencies extends WriteAllowanceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly costs: CostSeriesRepository;
  readonly throttles: WriteRefusalThrottleRepository;
  readonly offers: OfferSellUnitsSource;
  readonly policies: PricingPolicyProvider;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** Digits only, no sign, no leading zeros, at most 16 digits (design 4.4). */
const MINOR_UNITS = /^(?:0|[1-9][0-9]{0,15})$/;
const CURRENCY = /^[A-Z]{3}$/;

const NOT_FOUND = Object.freeze({ code: 'pricing.offer-not-found' as const });
const STALE = Object.freeze({ code: 'conflict.stale' as const });

type Written =
  | { readonly kind: 'written'; readonly output: SetOfferCostOutput }
  | { readonly kind: 'no-series' }
  | { readonly kind: 'refused'; readonly cause: 'key-retired' | 'not-yours' };

interface Checked {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  /** Null clears the Cost. */
  readonly amount: CostAmount | null;
  readonly currency: string;
}

/**
 * `pricing.set-cost` (pricing design 3.3, 5.2, 6.5, 8; brief s5, Q7, Q11; ux F41): a seller
 * records or clears the private Cost of one Variant of an own Offer. Rule `allOf
 * [pricing.price.edit, pricing.cost.view]` (H1: nobody overwrites a Cost they cannot see);
 * approved sellers only; refused in an acting-as session (design 5.4; Hassan finding 6).
 *
 * The order is the regular price's: input and the Market currency; the per-account write cap;
 * ownership through catalog's `offerSellUnits` before any unit (every refusal is the same
 * `pricing.offer-not-found` through the shared refusal unit, cause in the audit row only); one
 * write unit, serializable only when it creates the series (the tombstones are read there).
 * The audit row has no amount (H2); the record names the actor (Hassan finding 4). Cost is never
 * held, never reviewed and publishes no event (design 6.3). Logs: ids, codes and counts only.
 */
export class SetOfferCost extends UseCase<
  SetOfferCostInput,
  SetOfferCostOutput,
  SetOfferCostFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.set-cost',
    rule: { kind: 'permissions', allOf: [PRICING_PRICE_EDIT.key, PRICING_COST_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('SetOfferCost');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SetOfferCostDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SetOfferCostInput,
  ): Promise<Result<SetOfferCostOutput, SetOfferCostFailure>> {
    const { actor, market } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    if (isActingAsSession(actor)) {
      this.log('pricing.set-cost.acting-as-refused', context, {});
      return err({ code: 'pricing.acting-as-refused' });
    }
    const checked = this.check(context, input);
    if (!checked.ok) return checked;
    const { offerId, variantId } = checked.value;

    const allowed = await reserveWriteAllowance(this.deps, context, actor.accountId);
    if (!allowed.ok) return allowed;

    const offers = await this.deps.offers.sellUnitsOf(context, [offerId]);
    const offer = offers.get(offerId) ?? null;
    const cause = refusalCause(offer, actor.sellerId, variantId);
    if (cause !== null || offer === null) {
      return this.refuse(context, actor.accountId, offerId, variantId, cause ?? 'absent');
    }

    let written = await this.deps.unitOfWork.run(market, () =>
      this.write(context, input, checked.value, offer, actor.accountId, 'existing'),
    );
    if (written.ok && written.value.kind === 'no-series') {
      written = await runSerializable(this.deps.unitOfWork, market, () =>
        this.write(context, input, checked.value, offer, actor.accountId, 'create'),
      );
    }
    if (!written.ok) {
      this.log('pricing.set-cost.refused', context, { offerId, code: written.error.code });
      return written;
    }
    const outcome = written.value;
    if (outcome.kind === 'refused') {
      return this.refuse(context, actor.accountId, offerId, variantId, outcome.cause);
    }
    if (outcome.kind !== 'written') {
      throw new Error('pricing.set-cost: no series after the creating unit');
    }
    this.log('pricing.set-cost.done', context, { offerId, status: outcome.output.status });
    return ok(outcome.output);
  }

  /** Input shape, then the Market's currency and the range (design 4.4); codes and paths only. */
  private check(
    context: CallContext,
    input: SetOfferCostInput,
  ): Result<Checked, SetOfferCostFailure> {
    const fields: { path: string; code: string }[] = [];
    const offerId = parseId<'Offer'>(input?.offerId);
    if (!offerId.ok) fields.push({ path: 'offerId', code: 'format' });
    const variantId = parseId<'Variant'>(input?.variantId);
    if (!variantId.ok) fields.push({ path: 'variantId', code: 'format' });
    const cost: unknown = input?.cost;
    let amountText: string | null = null;
    let currency: string | null = null;
    if (cost !== null) {
      if (typeof cost !== 'object' || cost === undefined || Array.isArray(cost)) {
        fields.push({ path: 'cost', code: 'type' });
      } else {
        const { amount, currency: code } = cost as { amount?: unknown; currency?: unknown };
        if (typeof amount !== 'string' || !MINOR_UNITS.test(amount)) {
          fields.push({ path: 'cost.amount', code: 'format' });
        } else amountText = amount;
        if (typeof code !== 'string' || !CURRENCY.test(code)) {
          fields.push({ path: 'cost.currency', code: 'format' });
        } else currency = code;
      }
    }
    const expected: unknown = input?.expectedVersion;
    if (
      expected !== null &&
      !(typeof expected === 'number' && Number.isSafeInteger(expected) && expected >= 1)
    ) {
      fields.push({ path: 'expectedVersion', code: 'format' });
    }
    if (fields.length > 0 || !offerId.ok || !variantId.ok) {
      return err({ code: 'validation.failed', fields });
    }
    const marketCurrency = this.deps.policies.forOffer(context.market, offerId.value).currency;
    let amount: CostAmount | null = null;
    if (amountText !== null && currency !== null) {
      const parsed = costAmount(BigInt(amountText), currency, marketCurrency);
      if (!parsed.ok) return err(parsed.error);
      amount = parsed.value;
    }
    return ok({
      offerId: offerId.value,
      variantId: variantId.value,
      amount,
      currency: marketCurrency,
    });
  }

  private async write(
    context: CallContext,
    input: SetOfferCostInput,
    checked: Checked,
    offer: PricedOfferView,
    accountId: Id<'Account'>,
    mode: 'existing' | 'create',
  ): Promise<Result<Written, SetOfferCostFailure>> {
    const { market } = context;
    const { costs, clock, ids } = this.deps;
    const now = clock.now();
    const found = await costs.findByKey(market, {
      offerId: checked.offerId,
      variantId: checked.variantId,
    });
    if (found === null && mode === 'existing') {
      // Clearing a Cost that was never recorded writes nothing and creates no series.
      if (checked.amount === null) {
        if (input.expectedVersion !== null) return err(STALE);
        return ok({ kind: 'written', output: { status: 'unchanged', seriesVersion: null } });
      }
      return ok({ kind: 'no-series' });
    }
    // The series' seller copy must be the seller catalog names (Hassan L3).
    if (found !== null && found.state.sellerId !== offer.sellerId) {
      return ok({ kind: 'refused', cause: 'not-yours' });
    }
    if ((found?.persistedVersion ?? null) !== input.expectedVersion) return err(STALE);

    const series =
      found ??
      CostSeries.create({
        id: ids.next<'CostSeries'>(),
        marketId: market.marketId,
        offerId: checked.offerId,
        variantId: checked.variantId,
        productId: offer.productId,
        sellerId: offer.sellerId,
        currency: checked.currency,
        now,
      });
    const set = series.setCost({
      recordId: ids.next<'CostRecord'>(),
      amount: checked.amount,
      submittedBy: accountId,
      now,
    });
    if (!set.ok) return err(set.error);
    if (set.value.kind === 'unchanged') {
      return ok({
        kind: 'written',
        output: { status: 'unchanged', seriesVersion: series.persistedVersion },
      });
    }
    if (found === null) {
      if ((await costs.add(market, series)) === 'key-retired') {
        return ok({ kind: 'refused', cause: 'key-retired' });
      }
    } else {
      await costs.save(market, series);
    }
    const { id, offerId, variantId } = series.state;
    const after = { offerId, variantId, recordId: set.value.record.id };
    await this.deps.audit.record(
      context,
      checked.amount === null ? CostCleared.entry(id, { after }) : CostSet.entry(id, { after }),
    );
    return ok({
      kind: 'written',
      output: {
        status: checked.amount === null ? 'cleared' : 'recorded',
        seriesVersion: series.state.version,
      },
    });
  }

  /** Every cause: the same refusal unit, the same answer (design 5.2; Hassan finding 2). */
  private async refuse(
    context: CallContext,
    accountId: Id<'Account'>,
    offerId: Id<'Offer'>,
    variantId: Id<'Variant'>,
    cause: OfferWriteRefusalCause,
  ): Promise<Result<never, SetOfferCostFailure>> {
    const written = await recordOfferWriteRefusal(this.deps, context, {
      accountId,
      offerId,
      variantId,
      cause,
    });
    this.log('pricing.set-cost.offer-not-found', context, { offerId, audit: written });
    return err(NOT_FOUND);
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
