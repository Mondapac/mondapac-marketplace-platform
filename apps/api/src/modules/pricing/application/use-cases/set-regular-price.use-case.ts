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
  FirstPriceChecked,
  RegularPriceAccepted,
  RegularPriceHeld,
  RegularPriceSuperseded,
  type OfferWriteRefusalCause,
} from '../../domain/audit';
import { OfferPostReviewFlagged, POST_REVIEW_FLAG_VERSION } from '../../domain/events';
import { referenceAmountMinor } from '../../domain/reference-price';
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
import type { FirstPriceCheckOutcome } from '../ports/first-price-reference';
import { recheckFirstPrices } from '../reference/recheck';
import {
  gatherVariantReference,
  referenceFor,
  type FirstPriceReferencePorts,
  type GatheredReference,
  type VariantReference,
} from '../reference/variant-reference';
import { recordOfferWriteRefusal } from '../refusals/offer-write-refusal';
import { runSerializable } from '../serializable-unit';
import {
  reserveWriteAllowance,
  type WriteThrottled,
  type WriteAllowanceDependencies,
} from '../write-allowance';

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
  /** Q2: the price is at or below a running or scheduled special. */
  | { readonly code: 'pricing.regular-not-above-special' }
  | { readonly code: 'conflict.stale' }
  | WriteThrottled;

export interface SetRegularPriceDependencies extends WriteAllowanceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly series: PriceSeriesRepository;
  readonly throttles: WriteRefusalThrottleRepository;
  readonly offers: OfferSellUnitsSource;
  readonly policies: PricingPolicyProvider;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * R4 of the risk-based Offer approval (ADR-0051): the first price of a series is measured against
   * the Variant's reference. Always bound by the module; absent only in unit tests of the jump
   * rules, where a first price is then not measured.
   */
  readonly reference?: FirstPriceReferencePorts;
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
  | { readonly kind: 'refused'; readonly cause: 'key-retired' | 'not-yours' }
  /**
   * The series has no price yet and R4 has not been read: the unit commits nothing; the caller
   * reads the Variant's reference outside any unit and writes again.
   */
  | { readonly kind: 'needs-reference' };

/**
 * R4 for this write: `off` when the ports are not bound (unit tests of the jump rules), null
 * until the reference is read, then what was read.
 */
type FirstPriceR4 = 'off' | null | VariantReference;

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

    // The per-account cap, counted in its own unit before the Offer lookup (refused or not).
    const allowed = await reserveWriteAllowance(this.deps, context, actor.accountId);
    if (!allowed.ok) return allowed;

    const offers = await this.deps.offers.sellUnitsOf(context, [offerId]);
    const offer = offers.get(offerId) ?? null;
    const cause = refusalCause(offer, actor.sellerId, variantId);
    if (cause !== null || offer === null) {
      return this.refuse(context, actor.accountId, offerId, variantId, cause ?? 'absent');
    }

    // R4 (ADR-0051): a first price is measured against the Variant's reference, read outside any
    // unit (P 3.1 row 5) only when the series turns out to have no price yet.
    let r4: FirstPriceR4 = this.deps.reference === undefined ? 'off' : null;
    let gathered: GatheredReference | null = null;
    const readReference = async (): Promise<VariantReference> => {
      gathered = await gatherVariantReference(this.r4Deps(), context, {
        productId: offer.productId,
        variantId,
      });
      return referenceFor(gathered, actor.sellerId as Id<'Seller'>);
    };
    const existingUnit = () =>
      this.deps.unitOfWork.run(market, () =>
        this.write(context, input, checked.value, offer, actor.accountId, 'existing', r4),
      );
    let written = await existingUnit();
    if (written.ok && written.value.kind === 'needs-reference') {
      r4 = await readReference();
      written = await existingUnit();
    }
    if (written.ok && written.value.kind === 'no-series') {
      if (r4 === null) r4 = await readReference();
      const r4ForCreate = r4;
      written = await runSerializable(this.deps.unitOfWork, market, () =>
        this.write(context, input, checked.value, offer, actor.accountId, 'create', r4ForCreate),
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
    let forRecheck = gathered as GatheredReference | null;
    if (forRecheck !== null && this.deps.reference !== undefined) {
      const key = { productId: offer.productId, variantId };
      // An accepted first price is in force now and may be what completes the reference of an
      // earlier first price: read again after the commit, so the earlier ones are re-checked now,
      // not at the next first price. (A held price is not in force: what was read still holds.)
      // A first price is written once per series, so this second read is rare.
      if (outcome.output.status === 'accepted') {
        forRecheck = await gatherVariantReference(this.r4Deps(), context, key);
      }
      // The R4 re-check of earlier first prices with no reference.
      await recheckFirstPrices(
        { ...this.r4Deps(), audit: this.deps.audit, outbox: this.deps.outbox },
        context,
        key,
        forRecheck,
        checked.value.policy.currency,
      );
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
    r4: FirstPriceR4,
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
    // A first price (no price ever in force) needs the Variant's reference first (R4).
    const firstPrice = found === null || !found.hasPrice;
    if (firstPrice && r4 === null) {
      if (mode === 'create')
        throw new Error('pricing.set-regular-price: R4 not read before create');
      return ok({ kind: 'needs-reference' });
    }
    const measured = firstPrice && r4 !== null && r4 !== 'off' ? r4 : null;

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
      reference:
        measured?.kind === 'reference'
          ? { reference: measured.reference, bandPercent: measured.bandPercent }
          : null,
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
    if (measured !== null && outcome.kind !== 'unchanged') {
      await this.recordCheck(context, series, outcome.record, measured, outcome.kind === 'held');
    }
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
    } else if (outcome.kind === 'held' && outcome.record.reference === null) {
      // A first price held against the Variant's reference is audited by `first-price.checked`.
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

  private r4Deps() {
    const reference = this.deps.reference;
    if (reference === undefined) throw new Error('pricing.set-regular-price: R4 is not bound');
    return {
      unitOfWork: this.deps.unitOfWork,
      offers: this.deps.offers,
      clock: this.deps.clock,
      reference,
    };
  }

  /**
   * The R4 check of a first price (ADR-0051), in the unit of the write: the stored row (the
   * post-publication review list reads it) and its audit row. No reference, or none readable: the
   * price is accepted and the Offer goes to 100% post-publication review.
   */
  private async recordCheck(
    context: CallContext,
    series: PriceSeries,
    record: RegularPriceRecord,
    measured: VariantReference,
    held: boolean,
  ): Promise<void> {
    const { id, offerId, variantId, productId, sellerId } = series.state;
    const outcome: FirstPriceCheckOutcome =
      measured.kind === 'unavailable'
        ? 'reference-unavailable'
        : measured.kind === 'no-reference'
          ? 'no-reference'
          : held
            ? 'outside'
            : 'within';
    const postReview = outcome === 'no-reference' || outcome === 'reference-unavailable';
    const referenceMinor =
      measured.kind === 'reference' ? referenceAmountMinor(measured.reference) : null;
    const businesses =
      measured.kind === 'reference'
        ? measured.reference.businesses
        : measured.kind === 'no-reference'
          ? measured.businesses
          : 0;
    await this.reference().checks.record(context.market, {
      recordId: record.id,
      seriesId: id,
      offerId,
      productId,
      variantId,
      sellerId,
      outcome,
      referenceAmountMinor: referenceMinor,
      businesses,
      businessesNeeded: measured.businessesNeeded,
      bandPercent: measured.bandPercent,
      postReviewReason: postReview ? outcome : null,
      checkedAt: record.submittedAt,
    });
    await this.deps.audit.record(
      context,
      FirstPriceChecked.entry(id, {
        after: {
          offerId,
          variantId,
          recordId: record.id,
          amount: record.amount,
          outcome,
          referenceAmount:
            referenceMinor === null ? null : money(referenceMinor, record.amount.currency),
          businesses,
          businessesNeeded: measured.businessesNeeded,
          bandPercent: measured.bandPercent,
          direction: held ? record.heldDirection : null,
          postReview,
        },
      }),
    );
    if (postReview) {
      // Catalog's post-publication review list hears of it through pricing's own subscriber.
      await this.deps.outbox.append(context, [
        OfferPostReviewFlagged.record({
          aggregateId: record.id,
          aggregateVersion: POST_REVIEW_FLAG_VERSION.check,
          occurredAt: record.submittedAt,
          payload: { offerId, productId, sellerId, recordId: record.id, reason: outcome },
        }),
      ]);
    }
  }

  private reference(): FirstPriceReferencePorts {
    return this.r4Deps().reference;
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
export function refusalCause(
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
