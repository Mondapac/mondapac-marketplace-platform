import { compareMoney, err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId, PendingEvent, Result } from '@mondapac/shared-kernel';
import { EffectivePriceChanged, PriceHoldDecided, PriceHoldOpened } from './events';
import { measureJump } from './jump-policy';
import { priceAmount } from './price-amount';
import type { PriceAmount, PriceAmountError } from './price-amount';
import { windowStart } from './pricing-policy';
import type { PricingPolicy } from './pricing-policy';
import type { HoldRejectionReason, JumpAnchor, RetireCause, SupersedeCause } from './record-types';
import { liveOrScheduledSpecial, specialEnd, specialInForce } from './special-price';
import type { SpecialDecision, SpecialPriceRecord, WithdrawCause } from './special-price';

export { HOLD_REJECTION_REASONS } from './record-types';
export type { HoldRejectionReason, JumpAnchor, RetireCause, SupersedeCause } from './record-types';

export type RegularRecordStatus =
  'ACCEPTED' | 'APPROVED' | 'PENDING_REVIEW' | 'SUPERSEDED' | 'REJECTED';

/** Who decided a held record, when and why (pricing-data 3.3). Null while undecided. */
export interface RecordDecision {
  readonly decidedAt: Temporal.Instant;
  /** Never the submitting account (H4; also the table's `decider_check`). */
  readonly decidedBy: Id<'Account'>;
  /** Required for a rejection, absent for an approval. */
  readonly reasonCode: HoldRejectionReason | null;
  /** Personal free text of a rejection; never leaves the record (design 8). */
  readonly note: string | null;
}

/**
 * One regular price record (pricing design 2.1). Content never changes; only `status`, the end
 * of the effective period and the supersede fields move, each once.
 */
export interface RegularPriceRecord {
  readonly id: Id<'RegularPriceRecord'>;
  readonly amount: PriceAmount;
  /** The Market's `pricesIncludeTax` when this was written; never reinterpreted (design 4.5). */
  readonly taxInclusive: boolean;
  readonly status: RegularRecordStatus;
  readonly submittedAt: Temporal.Instant;
  readonly submittedBy: Id<'Account'>;
  /** Set when the record becomes effective; never by input. Null while pending. */
  readonly effectiveFrom: Temporal.Instant | null;
  /** Closed when the next record becomes effective. */
  readonly effectiveTo: Temporal.Instant | null;
  /**
   * The record this one was measured against (design 2.1, 2.4), held or not. Null only for a
   * record that was not measured: the first price of a series.
   */
  readonly anchor: JumpAnchor | null;
  readonly heldDirection: 'up' | 'down' | null;
  /** Set when a pending record is replaced; the record that replaced it, or null for another cause. */
  readonly supersededBy: Id<'RegularPriceRecord'> | null;
  readonly supersededAt: Temporal.Instant | null;
  /** Set with `SUPERSEDED`; `replaced` exactly when `supersededBy` names the successor. */
  readonly supersedeCause: SupersedeCause | null;
  /** Set exactly for `APPROVED` and `REJECTED` records. */
  readonly decision: RecordDecision | null;
}

export interface PriceSeriesState {
  readonly id: Id<'PriceSeries'>;
  readonly marketId: MarketId;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly productId: Id<'Product'>;
  readonly sellerId: Id<'Seller'>;
  /**
   * The Market's currency when the series was created, written once (pricing-data P2): every
   * record of the series is in it.
   */
  readonly currency: string;
  readonly createdAt: Temporal.Instant;
  readonly retiredAt: Temporal.Instant | null;
  readonly retireCause: RetireCause | null;
  readonly version: number;
  readonly regular: readonly RegularPriceRecord[];
  /** The special stream (pricing design 2.1): append-only, oldest submission first. */
  readonly specials: readonly SpecialPriceRecord[];
}

export interface SetRegularPriceInput {
  readonly recordId: Id<'RegularPriceRecord'>;
  readonly amount: PriceAmount;
  readonly submittedBy: Id<'Account'>;
  readonly taxInclusive: boolean;
  readonly now: Temporal.Instant;
  readonly policy: PricingPolicy;
}

/** What a seller's write did. `superseded` lists the pending records it replaced. */
export type SetRegularPriceOutcome =
  | {
      readonly kind: 'accepted';
      readonly record: RegularPriceRecord;
      /** The record whose effective period this one closed; null for the first price. */
      readonly previous: RegularPriceRecord | null;
      readonly superseded: readonly RegularPriceRecord[];
    }
  | {
      readonly kind: 'held';
      readonly record: RegularPriceRecord;
      readonly superseded: readonly RegularPriceRecord[];
    }
  | {
      /** The write equals the price in effect: a pending change, if any, is cancelled. */
      readonly kind: 'unchanged';
      readonly superseded: readonly RegularPriceRecord[];
    };

export interface ApproveHoldInput {
  readonly recordId: Id<'RegularPriceRecord'>;
  readonly decidedBy: Id<'Account'>;
  readonly now: Temporal.Instant;
  /** The policy in force now: the amount is checked again against it (design 3.1 row 3). */
  readonly policy: PricingPolicy;
}

export interface RejectHoldInput {
  readonly recordId: Id<'RegularPriceRecord'>;
  readonly decidedBy: Id<'Account'>;
  readonly reasonCode: HoldRejectionReason;
  /** Already normalised by the caller (trimmed, 1 to 1000 characters) or null. */
  readonly note: string | null;
  readonly now: Temporal.Instant;
}

export type HoldDecisionError =
  | { readonly code: 'pricing.series-retired' }
  | { readonly code: 'pricing.hold.not-found' }
  | { readonly code: 'pricing.hold.not-pending' }
  /** The decider submitted the record (H4). */
  | { readonly code: 'pricing.hold.own-submission' };

export type ApproveHoldError =
  | HoldDecisionError
  | { readonly code: 'pricing.policy-market-mismatch' }
  /** Q2: the held price is no longer strictly above a running or scheduled special. */
  | { readonly code: 'pricing.regular-not-above-special' }
  | PriceAmountError;

export type SetRegularPriceError =
  | { readonly code: 'pricing.series-retired' }
  | { readonly code: 'pricing.policy-market-mismatch' }
  /** Q2: a regular price at or below a running or scheduled special is refused. */
  | { readonly code: 'pricing.regular-not-above-special' }
  | PriceAmountError;

export interface SetSpecialPriceInput {
  readonly recordId: Id<'SpecialPriceRecord'>;
  readonly amount: PriceAmount;
  readonly submittedBy: Id<'Account'>;
  readonly taxInclusive: boolean;
  /** Null: start now. Otherwise not before `now`. */
  readonly startsAt: Temporal.Instant | null;
  readonly endsAt: Temporal.Instant;
  readonly now: Temporal.Instant;
  readonly policy: PricingPolicy;
}

export type SetSpecialPriceError =
  | { readonly code: 'pricing.series-retired' }
  | { readonly code: 'pricing.policy-market-mismatch' }
  | { readonly code: 'pricing.no-regular-price' }
  | { readonly code: 'pricing.special-not-below-regular' }
  | { readonly code: 'pricing.special-window.invalid' }
  | { readonly code: 'pricing.special-window.start-in-past' }
  | PriceAmountError;

/**
 * What a seller's special write did. `superseded`: pending specials it replaced (or, for a held
 * one, the earlier pending special); `withdrawn`: the running or scheduled special an accepted
 * one replaced.
 */
export interface SetSpecialPriceOutcome {
  readonly kind: 'accepted' | 'held';
  readonly record: SpecialPriceRecord;
  readonly superseded: readonly SpecialPriceRecord[];
  readonly withdrawn: SpecialPriceRecord | null;
}

export type WithdrawSpecialPriceError =
  | { readonly code: 'pricing.series-retired' }
  | { readonly code: 'pricing.special-price.not-found' };

export interface WithdrawSpecialPriceOutcome {
  /** The running or scheduled special that was ended now, or null when only a pending one existed. */
  readonly withdrawn: SpecialPriceRecord | null;
  /** The pending special that was cancelled, or null. */
  readonly cancelled: SpecialPriceRecord | null;
}

export interface ApproveSpecialHoldInput {
  readonly recordId: Id<'SpecialPriceRecord'>;
  readonly decidedBy: Id<'Account'>;
  readonly now: Temporal.Instant;
  readonly policy: PricingPolicy;
}

export type ApproveSpecialHoldError =
  | HoldDecisionError
  | { readonly code: 'pricing.policy-market-mismatch' }
  | { readonly code: 'pricing.special-not-below-regular' }
  /** The window ended while the special waited: the admin rejects it instead. */
  | { readonly code: 'pricing.special-window.ended' }
  | PriceAmountError;

export interface RejectSpecialHoldInput {
  readonly recordId: Id<'SpecialPriceRecord'>;
  readonly decidedBy: Id<'Account'>;
  readonly reasonCode: HoldRejectionReason;
  readonly note: string | null;
  readonly now: Temporal.Instant;
}

/** A stored series that breaks an invariant of design 2.1: refused on load, never repaired. */
export class InvalidPriceSeriesStateError extends Error {
  constructor(readonly reason: string) {
    super(`invalid price series state: ${reason}`);
    this.name = 'InvalidPriceSeriesStateError';
  }
}

const ONE_MS = { milliseconds: 1 };

/** A record that has been, or is, the regular price in force (never pending, rejected or superseded). */
function isPriced(record: RegularPriceRecord): boolean {
  return record.status === 'ACCEPTED' || record.status === 'APPROVED';
}

/**
 * The regular price in effect at `at` (pricing design 4.1 steps 1 and 2): the priced record
 * whose effective period contains the instant. A retired series has none.
 */
export function effectiveRegular(
  state: PriceSeriesState,
  at: Temporal.Instant,
): RegularPriceRecord | null {
  if (state.retiredAt !== null) return null;
  return regularInForce(state.regular, at);
}

/** The price a buyer pays at an instant, and what it is made of (pricing design 4.1). */
export interface EffectivePriceAt {
  readonly basis: 'regular' | 'special';
  readonly amount: PriceAmount;
  readonly taxInclusive: boolean;
  /** The record the amount comes from. */
  readonly recordId: Id<'RegularPriceRecord'> | Id<'SpecialPriceRecord'>;
  /** The end of the special window when the basis is `special`, else null. */
  readonly specialEndsAt: Temporal.Instant | null;
}

/**
 * The effective price at `at` (pricing design 4.1): the special in force when it is strictly
 * below the regular price in force, else the regular price; null when there is no regular price
 * in force. The strict comparison is repeated here as a fail-safe (a buyer never pays more than
 * the regular price), although Q2 already refuses a regular price at or below a special.
 */
export function effectivePriceAt(
  state: PriceSeriesState,
  at: Temporal.Instant,
): EffectivePriceAt | null {
  const regular = effectiveRegular(state, at);
  if (regular === null) return null;
  const special = specialInForce(state.specials, at);
  if (special !== null && compareMoney(special.amount, regular.amount) < 0) {
    return {
      basis: 'special',
      amount: special.amount,
      taxInclusive: special.taxInclusive,
      recordId: special.id,
      specialEndsAt: special.endsAt,
    };
  }
  return {
    basis: 'regular',
    amount: regular.amount,
    taxInclusive: regular.taxInclusive,
    recordId: regular.id,
    specialEndsAt: null,
  };
}

function regularInForce(
  records: readonly RegularPriceRecord[],
  at: Temporal.Instant,
): RegularPriceRecord | null {
  for (const record of records) {
    if (!isPriced(record) || record.effectiveFrom === null) continue;
    if (Temporal.Instant.compare(record.effectiveFrom, at) > 0) continue;
    if (record.effectiveTo !== null && Temporal.Instant.compare(record.effectiveTo, at) <= 0)
      continue;
    return record;
  }
  return null;
}

/**
 * The anchor of a regular price (pricing design 2.4, option A): the later, by effective start,
 * of (a) the record in effect at `now - W`, or the first priced record when the series is
 * younger, and (b) the latest `APPROVED` record. Null when the series has no priced record.
 */
export function jumpAnchor(
  records: readonly RegularPriceRecord[],
  now: Temporal.Instant,
  policy: PricingPolicy,
): RegularPriceRecord | null {
  const priced = records.filter(isPriced).filter((r) => r.effectiveFrom !== null);
  if (priced.length === 0) return null;
  const byStart = (a: RegularPriceRecord, b: RegularPriceRecord): number =>
    Temporal.Instant.compare(
      a.effectiveFrom as Temporal.Instant,
      b.effectiveFrom as Temporal.Instant,
    );
  const sorted = [...priced].sort(byStart);
  const back = regularInForce(sorted, windowStart(now, policy));
  const windowRecord = back ?? (sorted[0] as RegularPriceRecord);
  const approved = sorted.filter((r) => r.status === 'APPROVED');
  const latestApproved =
    approved.length > 0 ? (approved[approved.length - 1] as RegularPriceRecord) : null;
  if (latestApproved === null) return windowRecord;
  return byStart(latestApproved, windowRecord) > 0 ? latestApproved : windowRecord;
}

/** One event of a change, built once its version is known. */
type EventAt = (version: number) => PendingEvent;

/**
 * The price series of one Variant of one Offer in one Market (pricing design 2.1). This part
 * holds the regular stream: the seller's write with its jump hold. Specials, decisions and the
 * re-key arrive in later parts and slices.
 *
 * Events (pricing design 6.3): a change raises the version by one per event it records, in a
 * fixed order (a superseded pending record first, then the new record), and the n-th event
 * carries the n-th new version, so the outbox's unique `(aggregate, version)` holds (P 10; the
 * convention of catalog's Q-K3). A write that changes nothing raises nothing.
 */
export class PriceSeries {
  #state: PriceSeriesState;
  /** The state as last read from or written to storage; null for a series never stored. */
  #stored: PriceSeriesState | null;
  /** Events recorded since the aggregate was built, in the order of their versions. */
  readonly #events: PendingEvent[] = [];

  private constructor(state: PriceSeriesState, stored: boolean) {
    this.#state = freezeState(state);
    this.#stored = stored ? this.#state : null;
  }

  static create(input: {
    readonly id: Id<'PriceSeries'>;
    readonly marketId: MarketId;
    readonly offerId: Id<'Offer'>;
    readonly variantId: Id<'Variant'>;
    readonly productId: Id<'Product'>;
    readonly sellerId: Id<'Seller'>;
    /** The Market's currency (`PricingPolicy.currency`). */
    readonly currency: string;
    readonly now: Temporal.Instant;
  }): PriceSeries {
    return new PriceSeries(
      {
        id: input.id,
        marketId: input.marketId,
        offerId: input.offerId,
        variantId: input.variantId,
        productId: input.productId,
        sellerId: input.sellerId,
        currency: input.currency,
        createdAt: input.now,
        retiredAt: null,
        retireCause: null,
        version: 1,
        regular: [],
        specials: [],
      },
      false,
    );
  }

  /** Rebuilds a stored series; used by the repository. */
  static restore(state: PriceSeriesState): PriceSeries {
    checkStoredState(state);
    return new PriceSeries(state, true);
  }

  get state(): PriceSeriesState {
    return this.#state;
  }

  /**
   * The state as last read from or written to storage, or null for a series never stored. The
   * repository writes the difference between it and {@link state} (pricing-data P7).
   */
  get storedState(): PriceSeriesState | null {
    return this.#stored;
  }

  /** The version the series had in storage, or null for a series never stored (P 10). */
  get persistedVersion(): number | null {
    return this.#stored?.version ?? null;
  }

  /** Events recorded since the aggregate was built or restored, in version order. */
  get pendingEvents(): readonly PendingEvent[] {
    return [...this.#events];
  }

  /** Called by the repository once it has written the current state; nothing else calls it. */
  markStored(): void {
    this.#stored = this.#state;
  }

  /**
   * A seller sets the regular price (pricing design 3.1, 4.2). The first price is never held.
   * A price equal to the one in effect cancels a pending change and creates nothing. Otherwise
   * the jump policy measures it against the anchor: within the threshold it becomes effective at
   * `max(now, previous start + 1 ms)` and closes the previous period; beyond it, it waits as
   * `PENDING_REVIEW` and the previous price stays in force. Any pending record is superseded.
   * A price at or below a running or scheduled special is refused (Q2).
   */
  setRegularPrice(
    input: SetRegularPriceInput,
  ): Result<SetRegularPriceOutcome, SetRegularPriceError> {
    const state = this.#state;
    if (state.retiredAt !== null) return err({ code: 'pricing.series-retired' });
    if (input.policy.marketId !== state.marketId) {
      return err({ code: 'pricing.policy-market-mismatch' });
    }
    // The domain is the last control for the currency and the maximum (design 4.4): the amount
    // is checked again against the policy of this write, whoever built it.
    const checked = priceAmount(input.amount, input.policy);
    if (!checked.ok) return err(checked.error);
    // A series keeps the currency it was created in (pricing-data P2); a policy whose currency
    // drifted from it is refused here, before the database's foreign key would refuse it.
    if (input.amount.currency !== state.currency) return err({ code: 'pricing.currency-mismatch' });

    const latest = latestPriced(state.regular);
    const pending = state.regular.filter((r) => r.status === 'PENDING_REVIEW');

    // Compared with the latest priced record, not the one in force at `now`: a record queued
    // 1 ms ahead by an earlier write of the same instant is the seller's current intent.
    if (latest !== null && compareMoney(latest.amount, input.amount) === 0) {
      const superseded = pending.map((r) => supersede(r, 'cancelled', null, input.now));
      if (superseded.length > 0) {
        this.#commit(
          { regular: replace(state.regular, superseded) },
          this.#holdsSuperseded(superseded, input.now),
        );
      }
      return ok({ kind: 'unchanged', superseded });
    }

    // Q2 (design 3.1 row 1): a regular price at or below a running or scheduled special is
    // refused; the seller edits or ends the special first.
    const blocking = liveOrScheduledSpecial(state.specials, input.now);
    if (blocking !== null && compareMoney(input.amount, blocking.amount) <= 0) {
      return err({ code: 'pricing.regular-not-above-special' });
    }

    const anchorRecord = jumpAnchor(state.regular, input.now, input.policy);
    const verdict =
      anchorRecord === null
        ? ({ kind: 'within' } as const)
        : measureJump(anchorRecord.amount, input.amount, input.policy);

    const anchor: JumpAnchor | null =
      anchorRecord === null
        ? null
        : Object.freeze({ recordId: anchorRecord.id, amount: anchorRecord.amount });

    if (verdict.kind === 'held' && anchor !== null) {
      const record: RegularPriceRecord = Object.freeze({
        id: input.recordId,
        amount: input.amount,
        taxInclusive: input.taxInclusive,
        status: 'PENDING_REVIEW',
        submittedAt: input.now,
        submittedBy: input.submittedBy,
        effectiveFrom: null,
        effectiveTo: null,
        anchor,
        heldDirection: verdict.direction,
        supersededBy: null,
        supersededAt: null,
        supersedeCause: null,
        decision: null,
      });
      const superseded = pending.map((r) => supersede(r, 'replaced', record.id, input.now));
      const direction = verdict.direction;
      this.#commit({ regular: [...replace(state.regular, superseded), record] }, [
        ...this.#holdsSuperseded(superseded, input.now),
        (version) =>
          PriceHoldOpened.record({
            aggregateId: state.id,
            aggregateVersion: version,
            occurredAt: input.now,
            payload: {
              offerId: state.offerId,
              variantId: state.variantId,
              recordId: record.id,
              kind: 'regular',
              direction,
            },
          }),
      ]);
      return ok({ kind: 'held', record, superseded });
    }

    const start = effectiveStart(input.now, latest);
    const record: RegularPriceRecord = Object.freeze({
      id: input.recordId,
      amount: input.amount,
      taxInclusive: input.taxInclusive,
      status: 'ACCEPTED',
      submittedAt: input.now,
      submittedBy: input.submittedBy,
      effectiveFrom: start,
      effectiveTo: null,
      anchor,
      heldDirection: null,
      supersededBy: null,
      supersededAt: null,
      supersedeCause: null,
      decision: null,
    });
    const superseded = pending.map((r) => supersede(r, 'replaced', record.id, input.now));
    const closed = latest === null ? null : Object.freeze({ ...latest, effectiveTo: start });
    const next = replace(replace(state.regular, superseded), closed === null ? [] : [closed]);
    this.#commit({ regular: [...next, record] }, [
      ...this.#holdsSuperseded(superseded, input.now),
      (version) =>
        EffectivePriceChanged.record({
          aggregateId: state.id,
          aggregateVersion: version,
          occurredAt: input.now,
          payload: {
            offerId: state.offerId,
            variantId: state.variantId,
            cause: 'regular-accepted',
            effectiveFrom: start,
            previousProductId: null,
            previousVariantId: null,
          },
        }),
    ]);
    return ok({ kind: 'accepted', record, previous: closed, superseded });
  }

  /**
   * An admin approves a held price (pricing design 3.1 row 3). Re-checked here, whoever calls:
   * the series is not retired, the record is still pending, the decider did not submit it (H4),
   * and the amount passes the **current** policy's limits. The record becomes effective at
   * `max(now, previous start + 1 ms)`, so from approval and not from submission, closes the
   * previous period and becomes the new jump anchor (design 2.4). Events: `price-hold-decided`
   * (approved), then `effective-price-changed` (`hold-approved`). A price at or below a running
   * or scheduled special is refused (Q2) and stays pending.
   */
  approveHold(input: ApproveHoldInput): Result<RegularPriceRecord, ApproveHoldError> {
    const state = this.#state;
    const pending = this.#pendingForDecision(input.recordId, input.decidedBy);
    if (!pending.ok) return pending;
    if (input.policy.marketId !== state.marketId) {
      return err({ code: 'pricing.policy-market-mismatch' });
    }
    const record = pending.value;
    const checked = priceAmount(record.amount, input.policy);
    if (!checked.ok) return err(checked.error);
    if (record.amount.currency !== state.currency)
      return err({ code: 'pricing.currency-mismatch' });
    // Q2, applied when the price would take effect: the admin rejects such a record instead.
    const blocking = liveOrScheduledSpecial(state.specials, input.now);
    if (blocking !== null && compareMoney(record.amount, blocking.amount) <= 0) {
      return err({ code: 'pricing.regular-not-above-special' });
    }

    const latest = latestPriced(state.regular);
    const start = effectiveStart(input.now, latest);
    const approved: RegularPriceRecord = Object.freeze({
      ...record,
      status: 'APPROVED' as const,
      effectiveFrom: start,
      effectiveTo: null,
      decision: Object.freeze({
        decidedAt: input.now,
        decidedBy: input.decidedBy,
        reasonCode: null,
        note: null,
      }),
    });
    const closed = latest === null ? [] : [Object.freeze({ ...latest, effectiveTo: start })];
    this.#commit({ regular: replace(replace(state.regular, closed), [approved]) }, [
      this.#holdDecided(record.id, 'approved', input.now),
      (version) =>
        EffectivePriceChanged.record({
          aggregateId: state.id,
          aggregateVersion: version,
          occurredAt: input.now,
          payload: {
            offerId: state.offerId,
            variantId: state.variantId,
            cause: 'hold-approved',
            effectiveFrom: start,
            previousProductId: null,
            previousVariantId: null,
          },
        }),
    ]);
    return ok(approved);
  }

  /**
   * An admin rejects a held price (pricing design 3.1 row 4): same guards as an approval except
   * the limits (a rejection never makes a price effective). The previous price is untouched.
   * Event: `price-hold-decided` (rejected).
   */
  rejectHold(input: RejectHoldInput): Result<RegularPriceRecord, HoldDecisionError> {
    const pending = this.#pendingForDecision(input.recordId, input.decidedBy);
    if (!pending.ok) return pending;
    const rejected: RegularPriceRecord = Object.freeze({
      ...pending.value,
      status: 'REJECTED' as const,
      decision: Object.freeze({
        decidedAt: input.now,
        decidedBy: input.decidedBy,
        reasonCode: input.reasonCode,
        note: input.note,
      }),
    });
    this.#commit({ regular: replace(this.#state.regular, [rejected]) }, [
      this.#holdDecided(rejected.id, 'rejected', input.now),
    ]);
    return ok(rejected);
  }

  /** Whether a record of the special stream has this id (a held record to decide, design 3.2). */
  hasSpecial(recordId: string): boolean {
    return this.#state.specials.some((r) => r.id === recordId);
  }

  /**
   * A seller sets a special price (pricing design 3.2 rows 1 and 2, 4.3). Guards: not retired,
   * the policy is this Market's, the amount passes the policy limits and the series currency, a
   * regular price is in force and the special is strictly below it, the window starts now or later
   * and ends after it starts. A discount of more than the policy threshold from the regular price
   * or from the regular jump anchor (the larger of the two measures it, Hassan finding 1) is held
   * as `PENDING_REVIEW`: it does not take effect and the current special stays. Otherwise it is
   * `ACCEPTED`, effective from its start. Either way a pending special is superseded; an accepted
   * one also withdraws, now, the special that was running or scheduled (Q3: a new one replaces the
   * current one).
   */
  setSpecialPrice(
    input: SetSpecialPriceInput,
  ): Result<SetSpecialPriceOutcome, SetSpecialPriceError> {
    const state = this.#state;
    if (state.retiredAt !== null) return err({ code: 'pricing.series-retired' });
    if (input.policy.marketId !== state.marketId) {
      return err({ code: 'pricing.policy-market-mismatch' });
    }
    const checked = priceAmount(input.amount, input.policy);
    if (!checked.ok) return err(checked.error);
    if (input.amount.currency !== state.currency) return err({ code: 'pricing.currency-mismatch' });

    const regular = effectiveRegular(state, input.now);
    if (regular === null) return err({ code: 'pricing.no-regular-price' });
    if (compareMoney(input.amount, regular.amount) >= 0) {
      return err({ code: 'pricing.special-not-below-regular' });
    }
    const startsAt = input.startsAt ?? input.now;
    if (Temporal.Instant.compare(startsAt, input.now) < 0) {
      return err({ code: 'pricing.special-window.start-in-past' });
    }
    if (Temporal.Instant.compare(input.endsAt, startsAt) <= 0) {
      return err({ code: 'pricing.special-window.invalid' });
    }

    const anchorRecord = jumpAnchor(state.regular, input.now, input.policy) ?? regular;
    const reference = anchorRecord.amount.amount > regular.amount.amount ? anchorRecord : regular;
    const held = measureJump(reference.amount, input.amount, input.policy).kind === 'held';

    const base = {
      id: input.recordId,
      amount: input.amount,
      taxInclusive: input.taxInclusive,
      startsAt,
      endsAt: input.endsAt,
      submittedAt: input.now,
      submittedBy: input.submittedBy,
      regular: Object.freeze({ recordId: regular.id, amount: regular.amount }),
      anchor: Object.freeze({ recordId: anchorRecord.id, amount: anchorRecord.amount }),
      withdrawnAt: null,
      withdrawCause: null,
      supersededBy: null,
      supersededAt: null,
      supersedeCause: null,
      decision: null,
    } as const;
    const pending = state.specials.filter((r) => r.status === 'PENDING_REVIEW');
    const superseded = pending.map((r) => supersedeSpecial(r, 'replaced', base.id, input.now));

    if (held) {
      const record: SpecialPriceRecord = Object.freeze({
        ...base,
        status: 'PENDING_REVIEW' as const,
        heldDirection: 'down' as const,
        effectiveFrom: null,
      });
      this.#commit({ specials: [...replaceSpecials(state.specials, superseded), record] }, [
        ...this.#specialHoldsSuperseded(superseded, input.now),
        (version) =>
          PriceHoldOpened.record({
            aggregateId: state.id,
            aggregateVersion: version,
            occurredAt: input.now,
            payload: {
              offerId: state.offerId,
              variantId: state.variantId,
              recordId: record.id,
              kind: 'special',
              direction: 'down',
            },
          }),
      ]);
      return ok({ kind: 'held', record, superseded, withdrawn: null });
    }

    const record: SpecialPriceRecord = Object.freeze({
      ...base,
      status: 'ACCEPTED' as const,
      heldDirection: null,
      effectiveFrom: startsAt,
    });
    const current = liveOrScheduledSpecial(state.specials, input.now);
    const withdrawn =
      current === null ? null : withdrawSpecialRecord(current, 'replaced', input.now);
    const changed = withdrawn === null ? superseded : [...superseded, withdrawn];
    this.#commit({ specials: [...replaceSpecials(state.specials, changed), record] }, [
      ...this.#specialHoldsSuperseded(superseded, input.now),
      this.#specialStarted(startsAt, input.now),
    ]);
    return ok({ kind: 'accepted', record, superseded, withdrawn });
  }

  /**
   * A seller ends the running or scheduled special now, and cancels a pending one (pricing design
   * 3.2). Nothing to end or cancel is `pricing.special-price.not-found`. Events: one
   * `price-hold-decided` (superseded) for a cancelled pending special, then
   * `effective-price-changed` (`special-withdrawn`) when a special was ended.
   */
  withdrawSpecialPrice(
    now: Temporal.Instant,
  ): Result<WithdrawSpecialPriceOutcome, WithdrawSpecialPriceError> {
    const state = this.#state;
    if (state.retiredAt !== null) return err({ code: 'pricing.series-retired' });
    const current = liveOrScheduledSpecial(state.specials, now);
    const pending = state.specials.find((r) => r.status === 'PENDING_REVIEW') ?? null;
    if (current === null && pending === null)
      return err({ code: 'pricing.special-price.not-found' });
    const withdrawn = current === null ? null : withdrawSpecialRecord(current, 'withdrawn', now);
    const cancelled = pending === null ? null : supersedeSpecial(pending, 'cancelled', null, now);
    const changed = [withdrawn, cancelled].filter((r): r is SpecialPriceRecord => r !== null);
    const events: EventAt[] = [
      ...this.#specialHoldsSuperseded(cancelled === null ? [] : [cancelled], now),
    ];
    if (withdrawn !== null) {
      events.push((version) =>
        EffectivePriceChanged.record({
          aggregateId: state.id,
          aggregateVersion: version,
          occurredAt: now,
          payload: {
            offerId: state.offerId,
            variantId: state.variantId,
            cause: 'special-withdrawn',
            effectiveFrom: now,
            previousProductId: null,
            previousVariantId: null,
          },
        }),
      );
    }
    this.#commit({ specials: replaceSpecials(state.specials, changed) }, events);
    return ok({ withdrawn, cancelled });
  }

  /**
   * An admin approves a held special (pricing design 3.2 row 3). Re-checked here, whoever calls:
   * the series is not retired, the record is still pending, the decider did not submit it (H4),
   * the amount passes the **current** policy, it is still strictly below the **current** regular
   * price, and its window has not ended. It is effective from `max(startsAt, now)` until `endsAt`
   * and withdraws, now, the special that was running or scheduled. Events: `price-hold-decided`
   * (approved, special), then `effective-price-changed` (`special-started`).
   */
  approveSpecialHold(
    input: ApproveSpecialHoldInput,
  ): Result<SpecialPriceRecord, ApproveSpecialHoldError> {
    const state = this.#state;
    const pending = this.#pendingSpecialForDecision(input.recordId, input.decidedBy);
    if (!pending.ok) return pending;
    if (input.policy.marketId !== state.marketId) {
      return err({ code: 'pricing.policy-market-mismatch' });
    }
    const record = pending.value;
    const checked = priceAmount(record.amount, input.policy);
    if (!checked.ok) return err(checked.error);
    if (record.amount.currency !== state.currency)
      return err({ code: 'pricing.currency-mismatch' });
    const regular = effectiveRegular(state, input.now);
    if (regular === null || compareMoney(record.amount, regular.amount) >= 0) {
      return err({ code: 'pricing.special-not-below-regular' });
    }
    if (Temporal.Instant.compare(record.endsAt, input.now) <= 0) {
      return err({ code: 'pricing.special-window.ended' });
    }

    const start =
      Temporal.Instant.compare(record.startsAt, input.now) >= 0 ? record.startsAt : input.now;
    const decision: SpecialDecision = Object.freeze({
      decidedAt: input.now,
      decidedBy: input.decidedBy,
      reasonCode: null,
      note: null,
    });
    const approved: SpecialPriceRecord = Object.freeze({
      ...record,
      status: 'APPROVED' as const,
      effectiveFrom: start,
      decision,
    });
    const current = liveOrScheduledSpecial(state.specials, input.now);
    const withdrawn =
      current === null ? null : withdrawSpecialRecord(current, 'replaced', input.now);
    const changed = withdrawn === null ? [approved] : [withdrawn, approved];
    this.#commit({ specials: replaceSpecials(state.specials, changed) }, [
      this.#holdDecided(record.id, 'approved', input.now, 'special'),
      this.#specialStarted(start, input.now),
    ]);
    return ok(approved);
  }

  /**
   * An admin rejects a held special (pricing design 3.2): same guards as an approval except the
   * limits. The current special is untouched. Event: `price-hold-decided` (rejected, special).
   */
  rejectSpecialHold(input: RejectSpecialHoldInput): Result<SpecialPriceRecord, HoldDecisionError> {
    const pending = this.#pendingSpecialForDecision(input.recordId, input.decidedBy);
    if (!pending.ok) return pending;
    const rejected: SpecialPriceRecord = Object.freeze({
      ...pending.value,
      status: 'REJECTED' as const,
      decision: Object.freeze({
        decidedAt: input.now,
        decidedBy: input.decidedBy,
        reasonCode: input.reasonCode,
        note: input.note,
      }),
    });
    this.#commit({ specials: replaceSpecials(this.#state.specials, [rejected]) }, [
      this.#holdDecided(rejected.id, 'rejected', input.now, 'special'),
    ]);
    return ok(rejected);
  }

  /** The guards every special decision shares: not retired, found, still pending, not the submitter. */
  #pendingSpecialForDecision(
    recordId: Id<'SpecialPriceRecord'>,
    decidedBy: Id<'Account'>,
  ): Result<SpecialPriceRecord, HoldDecisionError> {
    const state = this.#state;
    if (state.retiredAt !== null) return err({ code: 'pricing.series-retired' });
    const record = state.specials.find((r) => r.id === recordId);
    if (record === undefined) return err({ code: 'pricing.hold.not-found' });
    if (record.status !== 'PENDING_REVIEW') return err({ code: 'pricing.hold.not-pending' });
    if (record.submittedBy === decidedBy) return err({ code: 'pricing.hold.own-submission' });
    return ok(record);
  }

  /** `effective-price-changed` (`special-started`): the special is, or will be at `effectiveFrom`. */
  #specialStarted(effectiveFrom: Temporal.Instant, now: Temporal.Instant): EventAt {
    const { id, offerId, variantId } = this.#state;
    return (version) =>
      EffectivePriceChanged.record({
        aggregateId: id,
        aggregateVersion: version,
        occurredAt: now,
        payload: {
          offerId,
          variantId,
          cause: 'special-started',
          effectiveFrom,
          previousProductId: null,
          previousVariantId: null,
        },
      });
  }

  /** The guards every decision shares: not retired, found, still pending, not the submitter. */
  #pendingForDecision(
    recordId: Id<'RegularPriceRecord'>,
    decidedBy: Id<'Account'>,
  ): Result<RegularPriceRecord, HoldDecisionError> {
    const state = this.#state;
    if (state.retiredAt !== null) return err({ code: 'pricing.series-retired' });
    const record = state.regular.find((r) => r.id === recordId);
    if (record === undefined) return err({ code: 'pricing.hold.not-found' });
    if (record.status !== 'PENDING_REVIEW') return err({ code: 'pricing.hold.not-pending' });
    if (record.submittedBy === decidedBy) return err({ code: 'pricing.hold.own-submission' });
    return ok(record);
  }

  #holdDecided(
    recordId: Id<'RegularPriceRecord'> | Id<'SpecialPriceRecord'>,
    outcome: 'approved' | 'rejected',
    now: Temporal.Instant,
    kind: 'regular' | 'special' = 'regular',
  ): EventAt {
    const { id, offerId, variantId } = this.#state;
    return (version) =>
      PriceHoldDecided.record({
        aggregateId: id,
        aggregateVersion: version,
        occurredAt: now,
        payload: { offerId, variantId, recordId, kind, outcome },
      });
  }

  /**
   * Stops the series (pricing design 6.4): the Offer was deleted or the Variant removed. A
   * pending record is superseded by the system; priced records stay as history. Events (design
   * 3.1 row 5 (c), 6.3): one `price-hold-decided` (superseded) per pending record, then one
   * `effective-price-changed` with cause `series-retired` (the key now has no valid price), one
   * version step each. Pending specials are superseded and a running or scheduled one is
   * withdrawn the same way (see {@link specialChanges} for what changed). Retiring a retired
   * series changes nothing and records nothing.
   */
  retire(cause: RetireCause, now: Temporal.Instant): readonly RegularPriceRecord[] {
    const state = this.#state;
    if (state.retiredAt !== null) return [];
    const superseded = state.regular
      .filter((r) => r.status === 'PENDING_REVIEW')
      .map((r) => supersede(r, cause, null, now));
    // The special stream stops with the series: a pending special is superseded and a running
    // or scheduled one is withdrawn, both by the system.
    const specialsSuperseded = state.specials
      .filter((r) => r.status === 'PENDING_REVIEW')
      .map((r) => supersedeSpecial(r, cause, null, now));
    const live = liveOrScheduledSpecial(state.specials, now);
    const specialsChanged =
      live === null
        ? specialsSuperseded
        : [...specialsSuperseded, withdrawSpecialRecord(live, cause, now)];
    this.#commit(
      {
        regular: replace(state.regular, superseded),
        specials: replaceSpecials(state.specials, specialsChanged),
        retiredAt: now,
        retireCause: cause,
      },
      [
        ...this.#holdsSuperseded(superseded, now),
        ...this.#specialHoldsSuperseded(specialsSuperseded, now),
        (version) =>
          EffectivePriceChanged.record({
            aggregateId: state.id,
            aggregateVersion: version,
            occurredAt: now,
            payload: {
              offerId: state.offerId,
              variantId: state.variantId,
              cause: 'series-retired',
              effectiveFrom: now,
              previousProductId: null,
              previousVariantId: null,
            },
          }),
      ],
    );
    return superseded;
  }

  /** `price-hold-decided` (superseded, kind special) for each pending special that was replaced, cancelled or retired. */
  #specialHoldsSuperseded(
    superseded: readonly SpecialPriceRecord[],
    now: Temporal.Instant,
  ): EventAt[] {
    const { id, offerId, variantId } = this.#state;
    return superseded.map(
      (record) => (version: number) =>
        PriceHoldDecided.record({
          aggregateId: id,
          aggregateVersion: version,
          occurredAt: now,
          payload: {
            offerId,
            variantId,
            recordId: record.id,
            kind: 'special',
            outcome: 'superseded',
          },
        }),
    );
  }

  /** `price-hold-decided` (superseded) for each pending record a write or a retirement superseded. */
  #holdsSuperseded(superseded: readonly RegularPriceRecord[], now: Temporal.Instant): EventAt[] {
    const { id, offerId, variantId } = this.#state;
    return superseded.map(
      (record) => (version: number) =>
        PriceHoldDecided.record({
          aggregateId: id,
          aggregateVersion: version,
          occurredAt: now,
          payload: {
            offerId,
            variantId,
            recordId: record.id,
            kind: 'regular',
            outcome: 'superseded',
          },
        }),
    );
  }

  /**
   * Announces a boundary of a special that has come (pricing design 11; the boundary job): a
   * `start` when its effective period began, an `end` when its natural end passed. Prices are
   * correct without it (4.1); the event only tells consumers to read them again. Records one
   * `effective-price-changed` (`special-started` or `special-ended`) and answers true, or records
   * nothing and answers false: the series is retired, the record is unknown, or it is not (or no
   * longer) a special whose boundary has passed (an empty period, a withdrawn end, a future time).
   */
  announceSpecialBoundary(
    recordId: Id<'SpecialPriceRecord'>,
    boundary: 'start' | 'end',
    now: Temporal.Instant,
  ): boolean {
    const state = this.#state;
    if (state.retiredAt !== null) return false;
    const record = state.specials.find((r) => r.id === recordId);
    if (record === undefined) return false;
    let at: Temporal.Instant;
    let cause: 'special-started' | 'special-ended';
    if (boundary === 'start') {
      // A withdrawn special counts until `withdrawnAt`; one withdrawn before its start never ran.
      if (record.effectiveFrom === null || !isRunnable(record)) return false;
      if (Temporal.Instant.compare(record.effectiveFrom, specialEnd(record)) >= 0) return false;
      at = record.effectiveFrom;
      cause = 'special-started';
    } else {
      if (record.status !== 'ACCEPTED' && record.status !== 'APPROVED') return false;
      if (record.withdrawnAt !== null) return false;
      at = record.endsAt;
      cause = 'special-ended';
    }
    if (Temporal.Instant.compare(at, now) > 0) return false;
    const { id, offerId, variantId } = state;
    this.#commit({}, [
      (version) =>
        EffectivePriceChanged.record({
          aggregateId: id,
          aggregateVersion: version,
          occurredAt: now,
          payload: {
            offerId,
            variantId,
            cause,
            effectiveFrom: at,
            previousProductId: null,
            previousVariantId: null,
          },
        }),
    ]);
    return true;
  }

  /**
   * Applies a change and its events: one version step per event. A change without an event is a
   * bug (P 10: the version moves only with an event), so it throws rather than step silently.
   */
  #commit(
    change: Partial<Pick<PriceSeriesState, 'regular' | 'specials' | 'retiredAt' | 'retireCause'>>,
    events: readonly EventAt[],
  ): void {
    if (events.length === 0) {
      throw new Error('PriceSeries: a change must record at least one event');
    }
    const from = this.#state.version;
    const recorded = events.map((at, index) => at(from + 1 + index));
    this.#state = freezeState({
      ...this.#state,
      ...change,
      version: from + events.length,
    });
    this.#events.push(...recorded);
  }
}

function latestPriced(records: readonly RegularPriceRecord[]): RegularPriceRecord | null {
  const open = records.filter((r) => isPriced(r) && r.effectiveTo === null);
  return open.length === 0 ? null : (open[open.length - 1] as RegularPriceRecord);
}

function effectiveStart(
  now: Temporal.Instant,
  previous: RegularPriceRecord | null,
): Temporal.Instant {
  if (previous === null || previous.effectiveFrom === null) return now;
  const floor = previous.effectiveFrom.add(ONE_MS);
  return Temporal.Instant.compare(now, floor) >= 0 ? now : floor;
}

function supersede(
  record: RegularPriceRecord,
  cause: SupersedeCause,
  by: Id<'RegularPriceRecord'> | null,
  at: Temporal.Instant,
): RegularPriceRecord {
  return Object.freeze({
    ...record,
    status: 'SUPERSEDED' as const,
    supersededBy: by,
    supersededAt: at,
    supersedeCause: cause,
  });
}

function replace(
  records: readonly RegularPriceRecord[],
  changed: readonly RegularPriceRecord[],
): RegularPriceRecord[] {
  return records.map((r) => changed.find((c) => c.id === r.id) ?? r);
}

function supersedeSpecial(
  record: SpecialPriceRecord,
  cause: SupersedeCause,
  by: Id<'SpecialPriceRecord'> | null,
  at: Temporal.Instant,
): SpecialPriceRecord {
  return Object.freeze({
    ...record,
    status: 'SUPERSEDED' as const,
    supersededBy: by,
    supersededAt: at,
    supersedeCause: cause,
  });
}

function withdrawSpecialRecord(
  record: SpecialPriceRecord,
  cause: WithdrawCause,
  at: Temporal.Instant,
): SpecialPriceRecord {
  return Object.freeze({
    ...record,
    status: 'WITHDRAWN' as const,
    withdrawnAt: at,
    withdrawCause: cause,
  });
}

function replaceSpecials(
  records: readonly SpecialPriceRecord[],
  changed: readonly SpecialPriceRecord[],
): SpecialPriceRecord[] {
  return records.map((r) => changed.find((c) => c.id === r.id) ?? r);
}

/**
 * The specials a change superseded or withdrew, found by comparing the series with the state it
 * was last stored in. Used by the retirement handlers to audit what a retirement did to the
 * special stream; empty for a series never stored.
 */
export function specialChanges(series: PriceSeries): {
  readonly superseded: readonly SpecialPriceRecord[];
  readonly withdrawn: readonly SpecialPriceRecord[];
} {
  const before = new Map((series.storedState?.specials ?? []).map((r) => [r.id, r.status]));
  const now = series.state.specials;
  return {
    superseded: now.filter((r) => r.status === 'SUPERSEDED' && before.get(r.id) !== 'SUPERSEDED'),
    withdrawn: now.filter((r) => r.status === 'WITHDRAWN' && before.get(r.id) !== 'WITHDRAWN'),
  };
}

function freezeRecord(record: RegularPriceRecord): RegularPriceRecord {
  return Object.freeze({
    ...record,
    amount: Object.freeze({ ...record.amount }),
    decision: record.decision === null ? null : Object.freeze({ ...record.decision }),
    anchor:
      record.anchor === null
        ? null
        : Object.freeze({
            recordId: record.anchor.recordId,
            amount: Object.freeze({ ...record.anchor.amount }),
          }),
  });
}

function freezeSpecial(record: SpecialPriceRecord): SpecialPriceRecord {
  return Object.freeze({
    ...record,
    amount: Object.freeze({ ...record.amount }),
    regular: Object.freeze({
      recordId: record.regular.recordId,
      amount: Object.freeze({ ...record.regular.amount }),
    }),
    anchor: Object.freeze({
      recordId: record.anchor.recordId,
      amount: Object.freeze({ ...record.anchor.amount }),
    }),
    decision: record.decision === null ? null : Object.freeze({ ...record.decision }),
  });
}

function freezeState(state: PriceSeriesState): PriceSeriesState {
  return Object.freeze({
    ...state,
    regular: Object.freeze(state.regular.map(freezeRecord)),
    specials: Object.freeze(state.specials.map(freezeSpecial)),
  });
}

// Fail fast on a stored series that no write could have produced (design 2.1). The database
// constraints are the main control; this is defence in depth against a corrupt row.
function checkStoredState(state: PriceSeriesState): void {
  const bad = (reason: string): never => {
    throw new InvalidPriceSeriesStateError(reason);
  };
  const foreign = (r: RegularPriceRecord): boolean =>
    r.amount.currency !== state.currency ||
    (r.anchor !== null && r.anchor.amount.currency !== state.currency);
  if (state.regular.some(foreign)) bad('a record is in another currency than the series');
  for (const r of state.regular) {
    const superseded = r.status === 'SUPERSEDED';
    if (superseded !== (r.supersedeCause !== null) || superseded !== (r.supersededAt !== null)) {
      bad('a superseded record needs its cause and instant, and only it');
    }
    if ((r.supersedeCause === 'replaced') !== (r.supersededBy !== null)) {
      bad('a replaced record names its successor, and only it');
    }
  }
  for (const r of state.regular) {
    const decided = r.status === 'APPROVED' || r.status === 'REJECTED';
    if (decided !== (r.decision !== null)) bad('a decision belongs to a decided record only');
    if (r.decision !== null) {
      if (r.decision.decidedBy === r.submittedBy) bad('a record was decided by its submitter');
      if ((r.status === 'REJECTED') !== (r.decision.reasonCode !== null)) {
        bad('a rejection needs its reason code, and only it');
      }
    }
  }
  const pending = state.regular.filter((r) => r.status === 'PENDING_REVIEW');
  if (pending.length > 1) bad('more than one pending record');
  if (pending.some((r) => r.effectiveFrom !== null || r.anchor === null)) {
    bad('a pending record must have an anchor and no effective start');
  }
  const priced = state.regular.filter(isPriced);
  if (priced.some((r) => r.effectiveFrom === null)) bad('a priced record has no effective start');
  const byStart = [...priced].sort((a, b) =>
    Temporal.Instant.compare(
      a.effectiveFrom as Temporal.Instant,
      b.effectiveFrom as Temporal.Instant,
    ),
  );
  byStart.forEach((record, index) => {
    const next = byStart[index + 1];
    if (next === undefined) {
      if (record.effectiveTo !== null) bad('the latest priced record must be open');
      return;
    }
    if (
      record.effectiveTo === null ||
      Temporal.Instant.compare(record.effectiveTo, next.effectiveFrom as Temporal.Instant) !== 0
    ) {
      bad('priced records must be contiguous and must not overlap');
    }
  });
  checkStoredSpecials(state, bad);
  if (state.retiredAt !== null && state.retireCause === null) bad('a retired series needs a cause');
}

function checkStoredSpecials(state: PriceSeriesState, bad: (reason: string) => never): void {
  const specials = state.specials;
  const foreign = (r: SpecialPriceRecord): boolean =>
    r.amount.currency !== state.currency ||
    r.regular.amount.currency !== state.currency ||
    r.anchor.amount.currency !== state.currency;
  if (specials.some(foreign)) bad('a special is in another currency than the series');
  const at = (a: Temporal.Instant, b: Temporal.Instant): number => Temporal.Instant.compare(a, b);
  for (const r of specials) {
    if (at(r.endsAt, r.startsAt) <= 0) bad('a special window must end after it starts');
    const superseded = r.status === 'SUPERSEDED';
    if (superseded !== (r.supersedeCause !== null) || superseded !== (r.supersededAt !== null)) {
      bad('a superseded special needs its cause and instant, and only it');
    }
    if ((r.supersedeCause === 'replaced') !== (r.supersededBy !== null)) {
      bad('a replaced special names its successor, and only it');
    }
    const withdrawn = r.status === 'WITHDRAWN';
    if (withdrawn !== (r.withdrawnAt !== null) || withdrawn !== (r.withdrawCause !== null)) {
      bad('a withdrawn special needs its cause and instant, and only it');
    }
    const decided = r.status === 'APPROVED' || r.status === 'REJECTED';
    if (r.decision !== null && !decided && !withdrawn)
      bad('a decision belongs to a decided special');
    if (decided && r.decision === null) bad('a decided special needs its decision');
    if (r.decision !== null) {
      if (r.decision.decidedBy === r.submittedBy) bad('a special was decided by its submitter');
      if ((r.status === 'REJECTED') !== (r.decision.reasonCode !== null)) {
        bad('a rejection needs its reason code, and only it');
      }
    }
    if (
      (r.status === 'PENDING_REVIEW') !==
      (r.heldDirection !== null && r.effectiveFrom === null)
    ) {
      bad('a pending special is a held one without an effective start');
    }
    const priced = r.status === 'ACCEPTED' || r.status === 'APPROVED';
    if (priced && r.effectiveFrom === null) bad('a priced special has no effective start');
    if (r.effectiveFrom !== null && at(r.effectiveFrom, r.startsAt) < 0) {
      bad('a special cannot take effect before its window starts');
    }
  }
  if (specials.filter((r) => r.status === 'PENDING_REVIEW').length > 1) {
    bad('more than one pending special');
  }
  // Effective periods never overlap (design 2.1, M4): `[effectiveFrom, min(endsAt, withdrawnAt))`.
  const periods = specials
    .filter(
      (r) =>
        r.effectiveFrom !== null &&
        (r.status === 'ACCEPTED' || r.status === 'APPROVED' || r.status === 'WITHDRAWN'),
    )
    .map((r) => {
      const from = r.effectiveFrom as Temporal.Instant;
      const end = specialEnd(r);
      return { from, end: at(end, from) < 0 ? from : end };
    })
    .sort((a, b) => at(a.from, b.from));
  periods.forEach((period, index) => {
    const next = periods[index + 1];
    if (next !== undefined && at(next.from, period.end) < 0)
      bad('special periods must not overlap');
  });
}

/** A special that was, or is, in force: never pending, rejected or superseded. */
function isRunnable(record: SpecialPriceRecord): boolean {
  return (
    record.status === 'ACCEPTED' || record.status === 'APPROVED' || record.status === 'WITHDRAWN'
  );
}
