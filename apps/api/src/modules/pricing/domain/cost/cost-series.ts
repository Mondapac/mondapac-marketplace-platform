import type { Id, MarketId, Temporal } from '@mondapac/shared-kernel';
import { sameCost, type CostAmount } from './cost-amount';

/** One Cost record (pricing design 2.1, 3.3): an amount, or "cleared" (Cost is optional, Q7). */
export interface CostRecord {
  readonly id: Id<'CostRecord'>;
  /** Null for a "cleared" record. */
  readonly amount: CostAmount | null;
  readonly submittedAt: Temporal.Instant;
  /** Who wrote it (Hassan finding 4): the audit row carries no amount, so the actor is here. */
  readonly submittedBy: Id<'Account'>;
}

/** Why a series was retired (design 6.4); written by the retirement handlers of a later slice. */
export type CostRetireCause = 'offer-removed' | 'variant-removed';

export interface CostSeriesState {
  readonly id: Id<'CostSeries'>;
  readonly marketId: MarketId;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  /** Copy from catalog's answer at creation (design 2.3; Hassan L4), never from the request. */
  readonly productId: Id<'Product'>;
  readonly sellerId: Id<'Seller'>;
  readonly currency: string;
  readonly retiredAt: Temporal.Instant | null;
  readonly retireCause: CostRetireCause | null;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
  /**
   * The latest stored record (the current Cost), or null when none was ever written. Records are
   * append-only (V4): older ones are never read back into the aggregate.
   */
  readonly latest: CostRecord | null;
  /** The record this unit of work appended, not stored yet. */
  readonly appended: CostRecord | null;
}

/** What a write did. `unchanged`: the requested Cost is already the current one; nothing is written. */
export type SetCostOutcome =
  { readonly kind: 'recorded'; readonly record: CostRecord } | { readonly kind: 'unchanged' };

export type SetCostError = { readonly code: 'pricing.series-retired' };

/**
 * The Cost series of one (Market, Offer, Variant) (pricing design 2.1, 3.3, 6.5): a root of its
 * own, apart from the price series, so loading a price never brings Cost into memory. No state
 * machine: each write appends a record and the latest is the current Cost. It is never held,
 * never reviewed and publishes no event (brief s5; design 6.3).
 */
export class CostSeries {
  #state: CostSeriesState;
  #stored: CostSeriesState | null;

  private constructor(state: CostSeriesState, stored: CostSeriesState | null) {
    this.#state = state;
    this.#stored = stored;
  }

  /** A new series, not stored yet; created by the first Cost write of a key. */
  static create(input: {
    readonly id: Id<'CostSeries'>;
    readonly marketId: MarketId;
    readonly offerId: Id<'Offer'>;
    readonly variantId: Id<'Variant'>;
    readonly productId: Id<'Product'>;
    readonly sellerId: Id<'Seller'>;
    readonly currency: string;
    readonly now: Temporal.Instant;
  }): CostSeries {
    return new CostSeries(
      {
        ...input,
        retiredAt: null,
        retireCause: null,
        version: 0,
        createdAt: input.now,
        latest: null,
        appended: null,
      },
      null,
    );
  }

  /** A stored series, as the repository read it. */
  static restore(state: Omit<CostSeriesState, 'appended'>): CostSeries {
    if (state.version < 1) throw new Error('cost series: a stored version starts at 1');
    const full: CostSeriesState = { ...state, appended: null };
    return new CostSeries(full, full);
  }

  get state(): CostSeriesState {
    return this.#state;
  }

  /** The state last read or written, or null for a series never stored. */
  get storedState(): CostSeriesState | null {
    return this.#stored;
  }

  /** The stored version: what the seller's screen sends back as `expectedVersion`. */
  get persistedVersion(): number | null {
    return this.#stored?.version ?? null;
  }

  /** The current Cost, or null when none was ever recorded or the last record cleared it. */
  get current(): CostAmount | null {
    const record = this.#state.appended ?? this.#state.latest;
    return record?.amount ?? null;
  }

  /**
   * Records `amount` as the Cost, or clears it when `amount` is null (Q7). The same Cost as the
   * current one records nothing (no row, no version raise). A retired series takes no Cost.
   */
  setCost(input: {
    readonly recordId: Id<'CostRecord'>;
    readonly amount: CostAmount | null;
    readonly submittedBy: Id<'Account'>;
    readonly now: Temporal.Instant;
  }): { ok: true; value: SetCostOutcome } | { ok: false; error: SetCostError } {
    if (this.#state.retiredAt !== null)
      return { ok: false, error: { code: 'pricing.series-retired' } };
    if (this.#state.appended !== null) throw new Error('cost series: one write per unit of work');
    if (sameCost(this.current, input.amount)) {
      return { ok: true, value: { kind: 'unchanged' } };
    }
    const record: CostRecord = {
      id: input.recordId,
      amount: input.amount,
      submittedAt: input.now,
      submittedBy: input.submittedBy,
    };
    this.#state = { ...this.#state, appended: record, version: this.#state.version + 1 };
    return { ok: true, value: { kind: 'recorded', record } };
  }

  /** Called by the repository after it wrote the state: the appended record becomes the latest. */
  markStored(): void {
    const { appended } = this.#state;
    const next: CostSeriesState = {
      ...this.#state,
      latest: appended ?? this.#state.latest,
      appended: null,
    };
    this.#state = next;
    this.#stored = next;
  }
}
