import { compareMoney, err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId, PendingEvent, Result } from '@mondapac/shared-kernel';
import { EffectivePriceChanged, PriceHoldDecided, PriceHoldOpened } from './events';
import { measureJump } from './jump-policy';
import { priceAmount } from './price-amount';
import type { PriceAmount, PriceAmountError } from './price-amount';
import { windowStart } from './pricing-policy';
import type { PricingPolicy } from './pricing-policy';

export type RegularRecordStatus =
  'ACCEPTED' | 'APPROVED' | 'PENDING_REVIEW' | 'SUPERSEDED' | 'REJECTED';

/** Why a series stopped taking prices (pricing design 6.4). */
export type RetireCause = 'offer-removed' | 'variant-removed';

/**
 * Why a pending record was superseded (pricing design 3.1 row 5; pricing-data 3.3, M6): a new
 * seller write replaced it, a write equal to the price in force cancelled it, or the series was
 * retired.
 */
export type SupersedeCause = 'replaced' | 'cancelled' | RetireCause;

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

export type SetRegularPriceError =
  | { readonly code: 'pricing.series-retired' }
  | { readonly code: 'pricing.policy-market-mismatch' }
  | PriceAmountError;

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
   * The special-price guard (design 3.1, Q2) joins this check with the special stream.
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
   * Stops the series (pricing design 6.4): the Offer was deleted or the Variant removed. A
   * pending record is superseded by the system; priced records stay as history. Events (design
   * 3.1 row 5 (c), 6.3): one `price-hold-decided` (superseded) per pending record, then one
   * `effective-price-changed` with cause `series-retired` (the key now has no valid price), one
   * version step each. Retiring a retired series changes nothing and records nothing.
   */
  retire(cause: RetireCause, now: Temporal.Instant): readonly RegularPriceRecord[] {
    const state = this.#state;
    if (state.retiredAt !== null) return [];
    const superseded = state.regular
      .filter((r) => r.status === 'PENDING_REVIEW')
      .map((r) => supersede(r, cause, null, now));
    this.#commit(
      { regular: replace(state.regular, superseded), retiredAt: now, retireCause: cause },
      [
        ...this.#holdsSuperseded(superseded, now),
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
   * Applies a change and its events: one version step per event. A change without an event is a
   * bug (P 10: the version moves only with an event), so it throws rather than step silently.
   */
  #commit(
    change: Partial<Pick<PriceSeriesState, 'regular' | 'retiredAt' | 'retireCause'>>,
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

function freezeRecord(record: RegularPriceRecord): RegularPriceRecord {
  return Object.freeze({
    ...record,
    amount: Object.freeze({ ...record.amount }),
    anchor:
      record.anchor === null
        ? null
        : Object.freeze({
            recordId: record.anchor.recordId,
            amount: Object.freeze({ ...record.anchor.amount }),
          }),
  });
}

function freezeState(state: PriceSeriesState): PriceSeriesState {
  return Object.freeze({ ...state, regular: Object.freeze(state.regular.map(freezeRecord)) });
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
  if (state.retiredAt !== null && state.retireCause === null) bad('a retired series needs a cause');
}
