import { Logger } from '@nestjs/common';
import { err, money, ok, parseId } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  MarketContext,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { PRICING_PRICE_EDIT } from '../../contracts/permissions';
import {
  RegularPriceAccepted,
  RegularPriceHeld,
  RegularPriceSuperseded,
  type OfferWriteRefusalCause,
} from '../../domain/audit';
import { priceAmount, type PriceAmount } from '../../domain/price-amount';
import {
  PriceSeries,
  type RegularPriceRecord,
  type SetRegularPriceOutcome,
} from '../../domain/price-series';
import type { PricingPolicy } from '../../domain/pricing-policy';
import type { OfferSellUnitsSource, PricedOfferView } from '../ports/offer-sell-units';
import type { PriceSeriesRepository } from '../ports/price-series.repository';
import type { PricingPolicyProvider } from '../ports/pricing-policy-provider';
import type { WriteRefusalThrottleRepository } from '../ports/write-refusal-throttle.repository';
import { recordOfferWriteRefusal } from '../refusals/offer-write-refusal';
import { runSerializable } from '../serializable-unit';

/** Input as the route will pass it (design 4.4: the amount is a string of minor units). */
export interface SetRegularPriceInput {
  readonly offerId: string;
  readonly variantId: string;
  readonly price: { readonly amount: string; readonly currency: string };
  /**
   * The series version the seller's screen showed, or null when it showed no price (design 9:
   * optimistic version). A mismatch answers `conflict.stale`.
   */
  readonly expectedVersion: number | null;
}

export interface SetRegularPriceOutput {
  /** `pending-review` is a success, not an error (design 5.5). */
  readonly status: 'accepted' | 'pending-review' | 'unchanged';
  /** The series version after the write: what the screen sends next time. */
  readonly seriesVersion: number;
  /** The new record; null when the write equalled the price in force. */
  readonly recordId: Id<'RegularPriceRecord'> | null;
  /** When an accepted price takes effect (now, or 1 ms after the previous start, design 9). */
  readonly effectiveFrom: Temporal.Instant | null;
}

export type SetRegularPriceFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'access.denied' }
  | { readonly code: 'pricing.offer-not-found' }
  | { readonly code: 'pricing.currency-mismatch' }
  | { readonly code: 'pricing.amount-out-of-range' }
  | { readonly code: 'pricing.series-retired' }
  | { readonly code: 'conflict.stale' };

export interface SetRegularPriceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly series: PriceSeriesRepository;
  readonly throttles: WriteRefusalThrottleRepository;
  readonly offers: OfferSellUnitsSource;
  readonly policies: PricingPolicyProvider;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** Digits only, no sign, no leading zeros, at most 16 digits (design 4.4; ADR-0007 decision 10). */
const MINOR_UNITS = /^(?:0|[1-9][0-9]{0,15})$/;
const CURRENCY = /^[A-Z]{3}$/;

const NOT_FOUND = Object.freeze({ code: 'pricing.offer-not-found' as const });
const STALE = Object.freeze({ code: 'conflict.stale' as const });

/** What the write unit decided. */
type Written =
  | { readonly kind: 'written'; readonly output: SetRegularPriceOutput }
  | { readonly kind: 'no-series' }
  /** Refused inside the unit, which then commits nothing; answered through the refusal unit. */
  | { readonly kind: 'refused'; readonly cause: 'key-retired' | 'not-yours' };

interface Checked {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly amount: PriceAmount;
  readonly policy: PricingPolicy;
}

/**
 * `pricing.set-regular-price` (pricing design 3.1 rows 1, 2 and the cancel of row 5; 4.2, 4.4,
 * 5.2, 8, 9; brief s4 flows 2 and 3; slice 1, part 3b). A seller sets the regular price of one
 * Variant of an own Offer, "from now" only.
 *
 * Order (design 5.2; P 3.1 row 5, T1 option A):
 * 1. The gate: `pricing.price.edit`, denied while the seller is not approved.
 * 2. Input, then the Market's currency and limits (`PriceAmount`): no Offer data is read yet.
 * 3. Ownership, before any unit: one call of catalog's `offerSellUnits` (CF1) through the
 *    {@link OfferSellUnitsSource} port. Absent (unknown or another Market), not the actor's
 *    seller, deleted, or a Variant outside its sell units all answer the same
 *    `pricing.offer-not-found`, after the same refusal unit (cause inside the audit row only).
 *    The answer is advisory; the tombstones and the serializable creating unit close what lands
 *    after it (design 6.4, 9).
 * 4. One write unit: READ COMMITTED for an existing series (a retirement raises its version, so
 *    a concurrent write is stale); for a first price, a `serializable` unit through
 *    `runSerializable`, the only one in which `PriceSeriesRepository.add` runs (Hassan M1). The
 *    audit rows and the events go in the same unit. A tombstone found there answers
 *    `pricing.offer-not-found` through the refusal unit, cause `key-retired`; so does a stored
 *    series whose seller copy is not the seller catalog names, cause `not-yours` (Hassan L3).
 *
 * The series' `productId` and `sellerId` copies come only from catalog's answer, never from
 * the request (design 2.3; Hassan L4). Not in this part: the Q2 guard against a running or
 * scheduled special (the special stream arrives with slice 5), the acting-as refusal (SEL-08
 * does not exist: `ActorContext` carries no acting-as account yet, design 5.4), the route and
 * its per-account rate limit (part 3c).
 */
export class SetRegularPrice extends UseCase<
  SetRegularPriceInput,
  SetRegularPriceOutput,
  SetRegularPriceFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.set-regular-price',
    rule: { kind: 'permissions', allOf: [PRICING_PRICE_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('SetRegularPrice');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SetRegularPriceDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SetRegularPriceInput,
  ): Promise<Result<SetRegularPriceOutput, SetRegularPriceFailure>> {
    const { actor, market } = context;
    // A seller key admits a seller only; checked again here, where the seller id is needed.
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    const checked = this.check(market, input);
    if (!checked.ok) return checked;
    const { offerId, variantId } = checked.value;

    const offers = await this.deps.offers.sellUnitsOf(context, [offerId]);
    const offer = offers.get(offerId) ?? null;
    const cause = refusalCause(offer, actor.sellerId, variantId);
    if (cause !== null || offer === null) {
      return this.refuse(context, actor.accountId, offerId, variantId, cause ?? 'absent');
    }

    const existing = await this.deps.unitOfWork.run(market, () =>
      this.write(context, input, checked.value, offer, actor.accountId, 'existing'),
    );
    let written = existing;
    if (existing.ok && existing.value.kind === 'no-series') {
      written = await runSerializable(this.deps.unitOfWork, market, () =>
        this.write(context, input, checked.value, offer, actor.accountId, 'create'),
      );
    }
    if (!written.ok) {
      this.log('pricing.set-regular-price.refused', context, { offerId, code: written.error.code });
      return written;
    }
    const outcome = written.value;
    if (outcome.kind === 'refused') {
      return this.refuse(context, actor.accountId, offerId, variantId, outcome.cause);
    }
    if (outcome.kind !== 'written') {
      throw new Error('pricing.set-regular-price: no series after the creating unit');
    }
    this.log('pricing.set-regular-price.done', context, {
      offerId,
      status: outcome.output.status,
      seriesVersion: outcome.output.seriesVersion,
    });
    return ok(outcome.output);
  }

  /** Input shape, then the Market's currency and limits (design 4.4); codes and paths only. */
  private check(
    market: MarketContext,
    input: SetRegularPriceInput,
  ): Result<Checked, SetRegularPriceFailure> {
    const fields: { path: string; code: string }[] = [];
    const offerId = parseId<'Offer'>(input?.offerId);
    if (!offerId.ok) fields.push({ path: 'offerId', code: 'format' });
    const variantId = parseId<'Variant'>(input?.variantId);
    if (!variantId.ok) fields.push({ path: 'variantId', code: 'format' });
    const amountText: unknown = input?.price?.amount;
    if (typeof amountText !== 'string' || !MINOR_UNITS.test(amountText)) {
      fields.push({ path: 'price.amount', code: 'format' });
    }
    const currency: unknown = input?.price?.currency;
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
      fields.push({ path: 'price.currency', code: 'format' });
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
    const policy = this.deps.policies.forOffer(market, offerId.value);
    // The currency is the Market's, never assumed (design 4.4, AC 1): compared before `money`.
    if (currency !== policy.currency) return err({ code: 'pricing.currency-mismatch' });
    const amount = priceAmount(money(BigInt(amountText as string), policy.currency), policy);
    if (!amount.ok) return err(amount.error);
    return ok({ offerId: offerId.value, variantId: variantId.value, amount: amount.value, policy });
  }

  /**
   * The body of a write unit. `existing`: only an existing series is written; none answers
   * `no-series` and commits nothing. `create` (inside `runSerializable`): the series is created
   * when there is none, else written like an existing one.
   */
  private async write(
    context: CallContext,
    input: SetRegularPriceInput,
    checked: Checked,
    offer: PricedOfferView,
    accountId: Id<'Account'>,
    mode: 'existing' | 'create',
  ): Promise<Result<Written, SetRegularPriceFailure>> {
    const { market } = context;
    const { series: repository, clock, ids } = this.deps;
    const key = { offerId: checked.offerId, variantId: checked.variantId };
    const now = clock.now();
    const found = await repository.findByKey(market, key);
    if (found === null && mode === 'existing') return ok({ kind: 'no-series' });
    // The series' seller copy must be the seller catalog names (design 2.3, 5.2; Hassan L3): a
    // series of another seller is answered as `pricing.offer-not-found` with cause `not-yours`,
    // the cause of an Offer whose seller is not the actor's, before the version is compared.
    if (found !== null && found.state.sellerId !== offer.sellerId) {
      return ok({ kind: 'refused', cause: 'not-yours' });
    }
    // The screen's version must be the stored one; a first price is written over "no price".
    if ((found?.persistedVersion ?? null) !== input.expectedVersion) return err(STALE);

    const series =
      found ??
      PriceSeries.create({
        id: ids.next<'PriceSeries'>(),
        marketId: market.marketId,
        offerId: checked.offerId,
        variantId: checked.variantId,
        // Copies from catalog's answer only (design 2.3; Hassan L4).
        productId: offer.productId,
        sellerId: offer.sellerId,
        currency: checked.policy.currency,
        now,
      });
    const set = series.setRegularPrice({
      recordId: ids.next<'RegularPriceRecord'>(),
      amount: checked.amount,
      submittedBy: accountId,
      taxInclusive: this.deps.policies.pricesIncludeTax(market),
      now,
      policy: checked.policy,
    });
    if (!set.ok) {
      if (set.error.code === 'pricing.policy-market-mismatch') {
        throw new Error('pricing.set-regular-price: the policy is of another Market');
      }
      return err({ code: set.error.code });
    }
    const outcome = set.value;
    if (outcome.kind === 'unchanged' && outcome.superseded.length === 0) {
      // Nothing changed: nothing is written, no row and no event (design 9).
      if (found === null) throw new Error('pricing.set-regular-price: a first price is unchanged');
      return ok({ kind: 'written', output: outputOf(series, outcome) });
    }

    if (found === null) {
      if ((await repository.add(market, series)) === 'key-retired') {
        return ok({ kind: 'refused', cause: 'key-retired' });
      }
    } else {
      await repository.save(market, series);
    }
    await this.audit(context, series, outcome);
    await this.deps.outbox.append(context, series.pendingEvents);
    return ok({ kind: 'written', output: outputOf(series, outcome) });
  }

  /** One audit row per transition (design 8): each superseded record, then the new record. */
  private async audit(
    context: CallContext,
    series: PriceSeries,
    outcome: SetRegularPriceOutcome,
  ): Promise<void> {
    const { id, offerId, variantId } = series.state;
    for (const record of outcome.superseded) {
      await this.deps.audit.record(
        context,
        RegularPriceSuperseded.entry(id, {
          after: {
            offerId,
            variantId,
            recordId: record.id,
            cause: supersedeCauseOf(record),
            supersededByRecordId: record.supersededBy,
          },
        }),
      );
    }
    if (outcome.kind === 'accepted') {
      await this.deps.audit.record(
        context,
        RegularPriceAccepted.entry(id, {
          after: {
            offerId,
            variantId,
            recordId: outcome.record.id,
            amount: outcome.record.amount,
            anchorRecordId: outcome.record.anchor?.recordId ?? null,
            anchorAmount: outcome.record.anchor?.amount ?? null,
            previousRecordId: outcome.previous?.id ?? null,
            effectiveFrom: effectiveFromOf(outcome.record),
          },
        }),
      );
    } else if (outcome.kind === 'held') {
      const { anchor, heldDirection } = outcome.record;
      if (anchor === null || heldDirection === null) {
        throw new Error('pricing.set-regular-price: a held record without its anchor');
      }
      await this.deps.audit.record(
        context,
        RegularPriceHeld.entry(id, {
          after: {
            offerId,
            variantId,
            recordId: outcome.record.id,
            amount: outcome.record.amount,
            anchorRecordId: anchor.recordId,
            anchorAmount: anchor.amount,
            direction: heldDirection,
          },
        }),
      );
    }
  }

  /** Every cause: the same refusal unit, the same answer (design 5.2; Hassan finding 2). */
  private async refuse(
    context: CallContext,
    accountId: Id<'Account'>,
    offerId: Id<'Offer'>,
    variantId: Id<'Variant'>,
    cause: OfferWriteRefusalCause,
  ): Promise<Result<never, SetRegularPriceFailure>> {
    const written = await recordOfferWriteRefusal(this.deps, context, {
      accountId,
      offerId,
      variantId,
      cause,
    });
    // The cause stays in the audit row: the log names only what was written.
    this.log('pricing.set-regular-price.offer-not-found', context, { offerId, audit: written });
    return err(NOT_FOUND);
  }

  /** Ids, codes and counts only: never an amount (P 12.3). */
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

/** Why catalog's answer refuses this write, or null when it allows it (design 5.2). */
function refusalCause(
  offer: PricedOfferView | null,
  sellerId: Id<'Seller'>,
  variantId: Id<'Variant'>,
): OfferWriteRefusalCause | null {
  if (offer === null) return 'absent';
  if (offer.sellerId !== sellerId) return 'not-yours';
  if (offer.deleted) return 'deleted';
  if (!offer.priceableVariantIds.has(variantId)) return 'variant-not-priceable';
  return null;
}

function supersedeCauseOf(record: RegularPriceRecord): 'replaced' | 'cancelled' {
  const cause = record.supersedeCause;
  if (cause !== 'replaced' && cause !== 'cancelled') {
    throw new Error('pricing.set-regular-price: a seller write superseded with a system cause');
  }
  return cause;
}

function effectiveFromOf(record: RegularPriceRecord): Temporal.Instant {
  if (record.effectiveFrom === null) throw new Error('an accepted record has no effective start');
  return record.effectiveFrom;
}

function outputOf(series: PriceSeries, outcome: SetRegularPriceOutcome): SetRegularPriceOutput {
  const seriesVersion = series.state.version;
  switch (outcome.kind) {
    case 'accepted':
      return {
        status: 'accepted',
        seriesVersion,
        recordId: outcome.record.id,
        effectiveFrom: outcome.record.effectiveFrom,
      };
    case 'held':
      return {
        status: 'pending-review',
        seriesVersion,
        recordId: outcome.record.id,
        effectiveFrom: null,
      };
    case 'unchanged':
      return { status: 'unchanged', seriesVersion, recordId: null, effectiveFrom: null };
  }
}
