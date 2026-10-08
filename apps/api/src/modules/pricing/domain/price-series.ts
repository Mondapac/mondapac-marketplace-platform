import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId, Result } from '@mondapac/shared-kernel';
import { measureJump } from './jump-policy';
import type { PriceAmount } from './price-amount';
import { windowStart } from './pricing-policy';
import type { PricingPolicy } from './pricing-policy';

export type RegularRecordStatus =
  'ACCEPTED' | 'APPROVED' | 'PENDING_REVIEW' | 'SUPERSEDED' | 'REJECTED';

/** Why a series stopped taking prices (pricing design 6.4). */
export type RetireCause = 'offer-removed' | 'variant-removed';

/** The record a held price was measured against (design 2.4), copied so it never changes. */
export interface JumpAnchor {
  readonly recordId: Id<'RegularPriceRecord'>;
  readonly amount: PriceAmount;
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
  readonly anchor: JumpAnchor | null;
  readonly heldDirection: 'up' | 'down' | null;
  /** Set when a pending record is replaced; the record that replaced it, or null for a system cause. */
  readonly supersededBy: Id<'RegularPriceRecord'> | null;
  readonly supersededAt: Temporal.Instant | null;
}

export interface PriceSeriesState {
  readonly id: Id<'PriceSeries'>;
  readonly marketId: MarketId;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly productId: Id<'Product'>;
  readonly sellerId: Id<'Seller'>;
  readonly createdAt: Temporal.Instant;
  readonly retiredAt: Temporal.Instant | null;
  readonly retireCause: RetireCause | null;
  readonly version: number;
  readonly regular: readonly RegularPriceRecord[];
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

export type SetRegularPriceError = { readonly code: 'pricing.series-retired' };

const ONE_MS = { milliseconds: 1 };

/** A record that has been, or is, the regular price in force (never pending, rejected or superseded). */
function isPriced(record: RegularPriceRecord): boolean {
  return record.status === 'ACCEPTED' || record.status === 'APPROVED';
}

/**
 * The regular price in effect at `at` (pricing design 4.1 steps 1 and 2): the priced record
 * whose effective period contains the instant. A retired series has none. Specials join the
 * resolver in slice 5.
 */
export function effectiveRegular(
  state: PriceSeriesState,
  at: Temporal.Instant,
): RegularPriceRecord | null {
  if (state.retiredAt !== null) return null;
  return regularInForce(state.regular, at);
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

/**
 * The price series of one Variant of one Offer in one Market (pricing design 2.1). This part
 * holds the regular stream: the seller's write with its jump hold. Specials, decisions and the
 * re-key arrive in later parts and slices.
 */
export class PriceSeries {
  #state: PriceSeriesState;

  private constructor(state: PriceSeriesState) {
    this.#state = freezeState(state);
  }

  static create(input: {
    readonly id: Id<'PriceSeries'>;
    readonly marketId: MarketId;
    readonly offerId: Id<'Offer'>;
    readonly variantId: Id<'Variant'>;
    readonly productId: Id<'Product'>;
    readonly sellerId: Id<'Seller'>;
    readonly now: Temporal.Instant;
  }): PriceSeries {
    return new PriceSeries({
      ...input,
      createdAt: input.now,
      retiredAt: null,
      retireCause: null,
      version: 1,
      regular: [],
    });
  }

  /** Rebuilds a stored series; used by the repository. */
  static restore(state: PriceSeriesState): PriceSeries {
    return new PriceSeries(state);
  }

  get state(): PriceSeriesState {
    return this.#state;
  }

  /**
   * A seller sets the regular price (pricing design 3.1, 4.2). The first price is never held.
   * A price equal to the one in effect cancels a pending change and creates nothing. Otherwise
   * the jump policy measures it against the anchor: within the threshold it becomes effective at
   * `max(now, previous start + 1 ms)` and closes the previous period; beyond it, it waits as
   * `PENDING_REVIEW` and the previous price stays in force. Any pending record is superseded.
   * The special-price guard (design 3.1, Q2) joins this check with the special stream.
   */
  setRegularPrice(
    input: SetRegularPriceInput,
  ): Result<SetRegularPriceOutcome, SetRegularPriceError> {
    const state = this.#state;
    if (state.retiredAt !== null) return err({ code: 'pricing.series-retired' });

    const latest = latestPriced(state.regular);
    const pending = state.regular.filter((r) => r.status === 'PENDING_REVIEW');

    // Compared with the latest priced record, not the one in force at `now`: a record queued
    // 1 ms ahead by an earlier write of the same instant is the seller's current intent.
    if (latest !== null && latest.amount.amount === input.amount.amount) {
      const superseded = pending.map((r) => supersede(r, null, input.now));
      this.#commit(replace(state.regular, superseded));
      return ok({ kind: 'unchanged', superseded });
    }

    const anchorRecord = jumpAnchor(state.regular, input.now, input.policy);
    const verdict =
      anchorRecord === null
        ? ({ kind: 'within' } as const)
        : measureJump(anchorRecord.amount, input.amount, input.policy);

    if (verdict.kind === 'held' && anchorRecord !== null) {
      const record: RegularPriceRecord = Object.freeze({
        id: input.recordId,
        amount: input.amount,
        taxInclusive: input.taxInclusive,
        status: 'PENDING_REVIEW',
        submittedAt: input.now,
        submittedBy: input.submittedBy,
        effectiveFrom: null,
        effectiveTo: null,
        anchor: Object.freeze({ recordId: anchorRecord.id, amount: anchorRecord.amount }),
        heldDirection: verdict.direction,
        supersededBy: null,
        supersededAt: null,
      });
      const superseded = pending.map((r) => supersede(r, record.id, input.now));
      this.#commit([...replace(state.regular, superseded), record]);
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
      anchor: null,
      heldDirection: null,
      supersededBy: null,
      supersededAt: null,
    });
    const superseded = pending.map((r) => supersede(r, record.id, input.now));
    const closed = latest === null ? null : Object.freeze({ ...latest, effectiveTo: start });
    const next = replace(replace(state.regular, superseded), closed === null ? [] : [closed]);
    this.#commit([...next, record]);
    return ok({ kind: 'accepted', record, previous: closed, superseded });
  }

  /**
   * Stops the series (pricing design 6.4): the Offer was deleted or the Variant removed. A
   * pending record is superseded by the system; priced records stay as history. Retiring a
   * retired series changes nothing.
   */
  retire(cause: RetireCause, now: Temporal.Instant): readonly RegularPriceRecord[] {
    const state = this.#state;
    if (state.retiredAt !== null) return [];
    const superseded = state.regular
      .filter((r) => r.status === 'PENDING_REVIEW')
      .map((r) => supersede(r, null, now));
    this.#state = freezeState({
      ...state,
      regular: replace(state.regular, superseded),
      retiredAt: now,
      retireCause: cause,
      version: state.version + 1,
    });
    return superseded;
  }

  #commit(regular: readonly RegularPriceRecord[]): void {
    this.#state = freezeState({ ...this.#state, regular, version: this.#state.version + 1 });
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
  by: Id<'RegularPriceRecord'> | null,
  at: Temporal.Instant,
): RegularPriceRecord {
  return Object.freeze({
    ...record,
    status: 'SUPERSEDED' as const,
    supersededBy: by,
    supersededAt: at,
  });
}

function replace(
  records: readonly RegularPriceRecord[],
  changed: readonly RegularPriceRecord[],
): RegularPriceRecord[] {
  return records.map((r) => changed.find((c) => c.id === r.id) ?? r);
}

function freezeState(state: PriceSeriesState): PriceSeriesState {
  return Object.freeze({ ...state, regular: Object.freeze([...state.regular]) });
}
