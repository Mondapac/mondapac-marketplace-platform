import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId, PendingEvent, Result } from '@mondapac/shared-kernel';
import { TaxRegistrationRecorded } from './events';
import {
  contains,
  isWellFormed,
  localDateOf,
  overlaps,
  startOfLocalDate,
  type EffectivePeriod,
} from './effective-period';

/** Who recorded a period (data design 3.7: a seller or an admin; never the system). */
export const TAX_RECORDERS = ['seller', 'admin'] as const;
export type TaxRecorderKind = (typeof TAX_RECORDERS)[number];

/**
 * One period of a seller's indirect-tax registration (sellers design 2.1 `SellerTaxProfile`,
 * 2.4; ADR-0007 decision 6; ADR-0009 V2): the answer, the local date the person entered and the
 * zone that turned it into `validFrom`, both stored so the instant can be explained later. The
 * platform decides nothing from the answer; `tax` reads it as of an invoice date.
 */
export interface TaxRegistrationPeriod extends EffectivePeriod {
  readonly id: Id<'TaxRegistrationPeriod'>;
  readonly registeredForIndirectTax: boolean;
  /** The local date the person entered (or the local date of the recording instant). */
  readonly effectiveFromLocal: Temporal.PlainDate;
  /** IANA zone used to turn the local date into `validFrom` (ADR-0005 decision 3). */
  readonly effectiveZone: string;
  readonly recordedBy: { readonly kind: TaxRecorderKind; readonly accountId: Id<'Account'> };
  readonly recordedAt: Temporal.Instant;
}

/** What a recording asks for. The date is the person's local date; see {@link SellerTaxProfile.record}. */
export interface TaxRegistrationInput {
  /** Minted by the use case from the injected `IdGenerator`. */
  readonly periodId: Id<'TaxRegistrationPeriod'>;
  readonly registeredForIndirectTax: boolean;
  /** Required when registered, absent when not (sellers design 14.3 Reza 13). */
  readonly effectiveFromLocal: Temporal.PlainDate | null;
  /** The seller's `operating_timezone` at recording, or the Market's fallback zone (ADR-0005). */
  readonly zone: string;
  readonly by: { readonly kind: TaxRecorderKind; readonly accountId: Id<'Account'> };
  readonly now: Temporal.Instant;
}

/** A recording or a cancellation the aggregate refused. Codes only. */
export type TaxRefused =
  | { readonly code: 'tax.effective-from-required' }
  | { readonly code: 'tax.effective-from-unexpected' }
  | { readonly code: 'tax.effective-from-range' }
  | { readonly code: 'tax.period-overlaps' }
  | { readonly code: 'tax.period-not-found' }
  | { readonly code: 'tax.period-started' };

/** The earliest local date a person may enter: a typo guard, not a tax rule (the Market decides those). */
export const EARLIEST_EFFECTIVE_FROM = Temporal.PlainDate.from('1970-01-01');
/** How far ahead a registration may be dated: one year. */
const LATEST_AHEAD = { years: 1 } as const;

/** What the repository must write after a change, in the order that keeps the no-overlap constraint satisfied. */
export interface TaxProfileChanges {
  /** Rows deleted first (a cancelled future period). */
  readonly deleted: readonly Id<'TaxRegistrationPeriod'>[];
  /** `valid_to` set on existing rows (the only column an update may touch). */
  readonly validToChanged: readonly {
    readonly id: Id<'TaxRegistrationPeriod'>;
    readonly validTo: Temporal.Instant | null;
  }[];
  /** Rows inserted last. */
  readonly inserted: readonly TaxRegistrationPeriod[];
}

/**
 * The tax profile of one seller (sellers design 2.1, 2.4 rule 4, 14.4 Q-M13), the root of its
 * periods (id = seller id). Held here whatever the entry point:
 *
 * - periods never overlap and are half-open (the database repeats the rule with `EXCLUDE USING
 *   gist`); a new period closes the open one at its own start, so the history is a chain;
 * - a period that has started is never rewritten, only closed by the next one (Q-M13); one that
 *   has not started may be cancelled, which re-opens the period it had closed;
 * - a "registered" answer carries the local date the person entered, turned into an instant at
 *   00:00 in the owning party's zone; a "not registered" answer starts at the recording instant;
 * - every change raises the version by one (the repository writes over the version it read) and
 *   records `sellers.tax-registration-recorded.v1` with the seller id only (Hassan L1).
 */
export class SellerTaxProfile {
  readonly #sellerId: Id<'Seller'>;
  readonly #marketId: MarketId;
  readonly #persistedVersion: number;
  #version: number;
  #periods: TaxRegistrationPeriod[];
  readonly #events: PendingEvent[] = [];
  readonly #deleted: Id<'TaxRegistrationPeriod'>[] = [];
  readonly #validToChanged = new Map<Id<'TaxRegistrationPeriod'>, Temporal.Instant | null>();
  readonly #inserted: TaxRegistrationPeriod[] = [];

  private constructor(input: {
    sellerId: Id<'Seller'>;
    marketId: MarketId;
    version: number;
    periods: readonly TaxRegistrationPeriod[];
  }) {
    this.#sellerId = input.sellerId;
    this.#marketId = input.marketId;
    this.#version = input.version;
    this.#persistedVersion = input.version;
    this.#periods = [...input.periods].sort((a, b) =>
      Temporal.Instant.compare(a.validFrom, b.validFrom),
    );
  }

  /** A stored profile with its periods, as the repository read them. */
  static restore(input: {
    readonly sellerId: Id<'Seller'>;
    readonly marketId: MarketId;
    readonly version: number;
    readonly periods: readonly TaxRegistrationPeriod[];
  }): SellerTaxProfile {
    for (const period of input.periods) {
      if (!isWellFormed(period)) throw new RangeError('A stored tax period is empty');
    }
    const profile = new SellerTaxProfile(input);
    for (let index = 1; index < profile.#periods.length; index += 1) {
      if (overlaps(profile.#periods[index - 1]!, profile.#periods[index]!)) {
        throw new RangeError('Stored tax periods overlap');
      }
    }
    return profile;
  }

  get sellerId(): Id<'Seller'> {
    return this.#sellerId;
  }

  get marketId(): MarketId {
    return this.#marketId;
  }

  get version(): number {
    return this.#version;
  }

  /** The version the profile had when it was read: the repository writes only over it. */
  get persistedVersion(): number {
    return this.#persistedVersion;
  }

  /** The periods, oldest first. */
  get periods(): readonly TaxRegistrationPeriod[] {
    return [...this.#periods];
  }

  get pendingEvents(): readonly PendingEvent[] {
    return [...this.#events];
  }

  get changes(): TaxProfileChanges {
    return {
      deleted: [...this.#deleted],
      validToChanged: [...this.#validToChanged].map(([id, validTo]) => ({ id, validTo })),
      inserted: [...this.#inserted],
    };
  }

  /** The period in force at an instant, or null (ADR-0007 decision 7: tax "as of" an invoice date). */
  asOf(at: Temporal.Instant): TaxRegistrationPeriod | null {
    return this.#periods.find((period) => contains(period, at)) ?? null;
  }

  /**
   * Records the seller's answer as a new period from its date. The previous open period is
   * closed at the new period's start, in the same change (Q-M13). The new period must start
   * after the latest period began: this slice never rewrites a started period.
   */
  record(input: TaxRegistrationInput): Result<TaxRegistrationPeriod, TaxRefused> {
    const { registeredForIndirectTax, effectiveFromLocal, zone, now } = input;
    let validFrom: Temporal.Instant;
    let local: Temporal.PlainDate;
    if (registeredForIndirectTax) {
      if (effectiveFromLocal === null) return err({ code: 'tax.effective-from-required' });
      const latest = localDateOf(now, zone).add(LATEST_AHEAD);
      if (
        Temporal.PlainDate.compare(effectiveFromLocal, EARLIEST_EFFECTIVE_FROM) < 0 ||
        Temporal.PlainDate.compare(effectiveFromLocal, latest) > 0
      ) {
        return err({ code: 'tax.effective-from-range' });
      }
      local = effectiveFromLocal;
      validFrom = startOfLocalDate(local, zone);
    } else {
      if (effectiveFromLocal !== null) return err({ code: 'tax.effective-from-unexpected' });
      validFrom = now;
      local = localDateOf(now, zone);
    }

    const latestPeriod = this.#periods.at(-1) ?? null;
    if (latestPeriod !== null) {
      const notAfterStart = Temporal.Instant.compare(validFrom, latestPeriod.validFrom) <= 0;
      // A closed latest period (its successor was cancelled, then a gap) must already have ended.
      const insideClosed =
        latestPeriod.validTo !== null &&
        Temporal.Instant.compare(validFrom, latestPeriod.validTo) < 0;
      if (notAfterStart || insideClosed) return err({ code: 'tax.period-overlaps' });
      if (latestPeriod.validTo === null) this.#close(latestPeriod, validFrom);
    }

    const period: TaxRegistrationPeriod = Object.freeze({
      id: input.periodId,
      registeredForIndirectTax,
      effectiveFromLocal: local,
      effectiveZone: zone,
      validFrom,
      validTo: null,
      recordedBy: Object.freeze({ ...input.by }),
      recordedAt: now,
    });
    this.#periods.push(period);
    this.#inserted.push(period);
    this.#changed(now);
    return ok(period);
  }

  /**
   * Cancels a period that has not started (Q-M13) and re-opens the period it had closed. A period
   * that has started is refused (`tax.period-started`): a correction is a new period from its date.
   */
  cancel(periodId: Id<'TaxRegistrationPeriod'>, now: Temporal.Instant): Result<void, TaxRefused> {
    const index = this.#periods.findIndex((period) => period.id === periodId);
    if (index === -1) return err({ code: 'tax.period-not-found' });
    const period = this.#periods[index]!;
    if (Temporal.Instant.compare(period.validFrom, now) <= 0) {
      return err({ code: 'tax.period-started' });
    }
    this.#periods.splice(index, 1);
    // A period inserted in this same change is simply never written.
    const insertedAt = this.#inserted.findIndex((row) => row.id === periodId);
    if (insertedAt === -1) this.#deleted.push(periodId);
    else this.#inserted.splice(insertedAt, 1);

    const previous = this.#periods[index - 1];
    if (
      previous !== undefined &&
      previous.validTo !== null &&
      Temporal.Instant.compare(previous.validTo, period.validFrom) === 0
    ) {
      // Re-open up to the next remaining period (if any), never over it.
      const next = this.#periods[index];
      this.#close(previous, next === undefined ? null : next.validFrom);
    }
    this.#changed(now);
    return ok(undefined);
  }

  #close(period: TaxRegistrationPeriod, validTo: Temporal.Instant | null): void {
    const closed = Object.freeze({ ...period, validTo });
    const position = this.#periods.indexOf(period);
    this.#periods[position] = closed;
    const insertedAt = this.#inserted.findIndex((row) => row.id === period.id);
    if (insertedAt === -1) this.#validToChanged.set(period.id, validTo);
    else this.#inserted[insertedAt] = closed;
  }

  #changed(now: Temporal.Instant): void {
    this.#version += 1;
    this.#events.push(
      TaxRegistrationRecorded.record({
        aggregateId: this.#sellerId,
        aggregateVersion: this.#version,
        occurredAt: now,
        payload: { sellerId: this.#sellerId },
      }),
    );
  }
}
