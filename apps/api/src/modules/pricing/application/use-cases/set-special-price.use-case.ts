import { Logger } from '@nestjs/common';
import { err, money, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PRICING_PRICE_EDIT } from '../../contracts/permissions';
import {
  SpecialPriceAccepted,
  SpecialPriceHeld,
  SpecialPriceSuperseded,
  SpecialPriceWithdrawn,
} from '../../domain/audit';
import { priceAmount, type PriceAmount } from '../../domain/price-amount';
import type { PriceSeries, SetSpecialPriceOutcome } from '../../domain/price-series';
import { holdReference } from '../../domain/special-price';
import type { PricingPolicy } from '../../domain/pricing-policy';
import type { PricingPolicyProvider } from '../ports/pricing-policy-provider';
import {
  sellerSeriesWrite,
  type SellerSeriesWriteDependencies,
  type SellerSeriesWriteFailure,
} from '../seller-series-write';
import { reserveWriteAllowance, type WriteThrottled } from '../write-allowance';

/** Input as the route will pass it: the amount is a string of minor units, instants are UTC text. */
export interface SetSpecialPriceInput {
  readonly offerId: string;
  readonly variantId: string;
  readonly price: { readonly amount: string; readonly currency: string };
  /** A UTC instant (`2026-10-20T01:00:00Z`), or null to start now. */
  readonly startsAt: string | null;
  /** A UTC instant after the start. */
  readonly endsAt: string;
  /** The series version the seller's screen showed: a special needs a regular price first. */
  readonly expectedVersion: number;
}

export interface SetSpecialPriceOutput {
  /** `pending-review` is a success, not an error: a deep discount waits for an admin. */
  readonly status: 'accepted' | 'pending-review';
  /** The series version after the write: what the screen sends next time. */
  readonly seriesVersion: number;
  readonly recordId: Id<'SpecialPriceRecord'>;
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant;
  /** When an accepted special takes effect; null while it waits for review. */
  readonly effectiveFrom: Temporal.Instant | null;
}

export type SetSpecialPriceFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'access.denied' }
  | SellerSeriesWriteFailure
  | WriteThrottled
  | { readonly code: 'pricing.currency-mismatch' }
  | { readonly code: 'pricing.amount-out-of-range' }
  | { readonly code: 'pricing.series-retired' }
  | { readonly code: 'pricing.no-regular-price' }
  | { readonly code: 'pricing.special-not-below-regular' }
  | { readonly code: 'pricing.special-window.invalid' }
  | { readonly code: 'pricing.special-window.start-in-past' };

export interface SetSpecialPriceDependencies extends SellerSeriesWriteDependencies {
  readonly policies: PricingPolicyProvider;
  readonly ids: IdGenerator;
}

/** Digits only, no sign, no leading zeros, at most 16 digits (design 4.4; ADR-0007 decision 10). */
const MINOR_UNITS = /^(?:0|[1-9][0-9]{0,15})$/;
const CURRENCY = /^[A-Z]{3}$/;
/** A UTC instant with at most millisecond precision: no offsets, so the text means one instant. */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

interface Checked {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly amount: PriceAmount;
  readonly policy: PricingPolicy;
  readonly startsAt: Temporal.Instant | null;
  readonly endsAt: Temporal.Instant;
  readonly expectedVersion: number;
}

/**
 * `pricing.set-special-price` (pricing design 3.2 rows 1 and 2, 4.3, 5.2, 9; slice 5). A seller
 * sets a special price of one Variant of an own Offer for a window of two UTC instants (the
 * panel converts the seller's local times). Under the Market's discount threshold it is
 * accepted and takes effect at its start; beyond it, it is held for an admin and the current
 * special stays. A new special replaces the running or scheduled one (Q3). A special needs a
 * regular price in force and is strictly below it. Ownership and the refusal answers are those
 * of `pricing.set-regular-price`.
 *
 * Differences from the approved design, by the hybrid scope of 2026-10-14: the window is two UTC
 * instants (no seller zone, so no `local-time-invalid` and no `seller-zone-unavailable`); a
 * replaced special ends at the moment of replacement, not at the new one's start; and the
 * boundary-marker job is not built (prices are correct without it, design 4.1).
 */
export class SetSpecialPrice extends UseCase<
  SetSpecialPriceInput,
  SetSpecialPriceOutput,
  SetSpecialPriceFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.set-special-price',
    rule: { kind: 'permissions', allOf: [PRICING_PRICE_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('SetSpecialPrice');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SetSpecialPriceDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SetSpecialPriceInput,
  ): Promise<Result<SetSpecialPriceOutput, SetSpecialPriceFailure>> {
    const { actor, market } = context;
    // A seller key admits a seller only; checked again here, where the seller id is needed.
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    const checked = this.check(context, input);
    if (!checked.ok) return checked;
    const { offerId, variantId, amount, policy, startsAt, endsAt } = checked.value;
    const allowed = await reserveWriteAllowance(this.deps, context, actor.accountId);
    if (!allowed.ok) return allowed;
    const recordId = this.deps.ids.next<'SpecialPriceRecord'>();

    const written = await sellerSeriesWrite<SetSpecialPriceOutcome, SetSpecialPriceFailure>(
      this.deps,
      context,
      this.#logger,
      {
        accountId: actor.accountId,
        sellerId: actor.sellerId,
        offerId,
        variantId,
        expectedVersion: checked.value.expectedVersion,
        missingSeries: { code: 'pricing.no-regular-price' },
        apply: (series, now) => {
          const set = series.setSpecialPrice({
            recordId,
            amount,
            submittedBy: actor.accountId,
            taxInclusive: this.deps.policies.pricesIncludeTax(market),
            startsAt,
            endsAt,
            now,
            policy,
          });
          if (!set.ok) {
            if (set.error.code === 'pricing.policy-market-mismatch') {
              throw new Error('pricing.set-special-price: the policy is of another Market');
            }
            return err({ code: set.error.code });
          }
          return ok(set.value);
        },
        audit: (series, outcome) => this.audit(context, series, outcome),
      },
    );
    this.#logger.log({
      msg: 'pricing.set-special-price',
      outcome: written.ok ? outcomeOf(written.value.value) : written.error.code,
      offerId,
      accountId: actor.accountId,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    if (!written.ok) return written;
    const { value: outcome, series } = written.value;
    return ok({
      status: outcome.kind === 'accepted' ? 'accepted' : 'pending-review',
      seriesVersion: series.state.version,
      recordId: outcome.record.id,
      startsAt: outcome.record.startsAt,
      endsAt: outcome.record.endsAt,
      effectiveFrom: outcome.record.effectiveFrom,
    });
  }

  /** Input shape, then the Market's currency and limits (design 4.4); codes and paths only. */
  private check(
    context: CallContext,
    input: SetSpecialPriceInput,
  ): Result<Checked, SetSpecialPriceFailure> {
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
    const startsAt = parseInstant(input?.startsAt, true);
    if (startsAt === 'invalid') fields.push({ path: 'startsAt', code: 'format' });
    const endsAt = parseInstant(input?.endsAt, false);
    if (endsAt === 'invalid' || endsAt === null) fields.push({ path: 'endsAt', code: 'format' });
    const expected: unknown = input?.expectedVersion;
    if (!(typeof expected === 'number' && Number.isSafeInteger(expected) && expected >= 1)) {
      fields.push({ path: 'expectedVersion', code: 'format' });
    }
    if (
      fields.length > 0 ||
      !offerId.ok ||
      !variantId.ok ||
      startsAt === 'invalid' ||
      endsAt === 'invalid' ||
      endsAt === null
    ) {
      return err({ code: 'validation.failed', fields });
    }
    const policy = this.deps.policies.forOffer(context.market, offerId.value);
    // The currency is the Market's, never assumed (design 4.4, AC 1): compared before `money`.
    if (currency !== policy.currency) return err({ code: 'pricing.currency-mismatch' });
    const amount = priceAmount(money(BigInt(amountText as string), policy.currency), policy);
    if (!amount.ok) return err(amount.error);
    return ok({
      offerId: offerId.value,
      variantId: variantId.value,
      amount: amount.value,
      policy,
      startsAt,
      endsAt,
      expectedVersion: expected as number,
    });
  }

  /** One audit row per transition (design 8): superseded, withdrawn, then the new record. */
  private async audit(
    context: CallContext,
    series: PriceSeries,
    outcome: SetSpecialPriceOutcome,
  ): Promise<void> {
    const { id, offerId, variantId } = series.state;
    for (const record of outcome.superseded) {
      await this.deps.audit.record(
        context,
        SpecialPriceSuperseded.entry(id, {
          after: {
            offerId,
            variantId,
            recordId: record.id,
            cause: 'replaced',
            supersededByRecordId: record.supersededBy,
          },
        }),
      );
    }
    if (outcome.withdrawn !== null) {
      await this.deps.audit.record(
        context,
        SpecialPriceWithdrawn.entry(id, {
          after: { offerId, variantId, recordId: outcome.withdrawn.id, cause: 'replaced' },
        }),
      );
    }
    const { record } = outcome;
    if (outcome.kind === 'accepted') {
      if (record.effectiveFrom === null) {
        throw new Error('pricing.set-special-price: an accepted special has no start');
      }
      await this.deps.audit.record(
        context,
        SpecialPriceAccepted.entry(id, {
          after: {
            offerId,
            variantId,
            recordId: record.id,
            amount: record.amount,
            startsAt: record.startsAt,
            endsAt: record.endsAt,
            effectiveFrom: record.effectiveFrom,
          },
        }),
      );
    } else {
      await this.deps.audit.record(
        context,
        SpecialPriceHeld.entry(id, {
          after: {
            offerId,
            variantId,
            recordId: record.id,
            amount: record.amount,
            startsAt: record.startsAt,
            endsAt: record.endsAt,
            referenceAmount: holdReference(record).amount,
          },
        }),
      );
    }
  }
}

function outcomeOf(outcome: SetSpecialPriceOutcome): string {
  return outcome.kind === 'accepted' ? 'accepted' : 'pending-review';
}

/** `invalid` for text that is not a UTC instant; null for an absent start (when allowed). */
function parseInstant(value: unknown, nullable: boolean): Temporal.Instant | null | 'invalid' {
  if (value === null || value === undefined) return nullable ? null : 'invalid';
  if (typeof value !== 'string' || !UTC_INSTANT.test(value)) return 'invalid';
  try {
    return Temporal.Instant.from(value);
  } catch {
    return 'invalid';
  }
}
