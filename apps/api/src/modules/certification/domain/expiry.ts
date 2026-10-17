import { Temporal } from '@mondapac/shared-kernel';
import type { TimeZoneId } from './claim-types';
import { expiryBoundary, isUsableZone, type SellerCertificationStatus } from './validity';

// The decision of the expiry and warning job for one seller certificate (certification design
// 3.1, 8.6; AC 8, AC 9; CERT-14, CERT-15). Pure: time and the seller's zones come in as
// arguments (ADR-0005 decision 5). The job only writes a record of what the boundary already
// decided: `evaluateClaims` answers "no" at the boundary whether or not the job ran (2.4 rule 4).

/** What the job knows of an approved certificate (its approved submission and decision). */
export interface ExpiryFacts {
  readonly status: SellerCertificationStatus;
  /** From the approved submission's own type revision (2.4 rule 5). */
  readonly requiresExpiry: boolean;
  /** The expiry date as written, a local date. */
  readonly expiryDate: Temporal.PlainDate | null;
  /** The zone the boundary was computed in at approval. */
  readonly zoneAtApproval: string | null;
  /** The boundary stored with the approval (the decision row). */
  readonly storedBoundary: Temporal.Instant | null;
  /** The thresholds already marked for the approved submission (one marker each). */
  readonly warnedThresholds: readonly number[];
}

/** The seller's current approved zones, as `approvedSellerZones` answers them; null when unread. */
export interface CurrentZones {
  readonly zone: string | null;
  readonly addressZone: string | null;
}

/** The boundary and the zone that gave it (null zone: only the stored instant was usable). */
export interface JobBoundary {
  readonly at: Temporal.Instant;
  readonly zone: TimeZoneId | null;
}

export type ExpiryAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'expire'; readonly boundary: Temporal.Instant }
  | {
      readonly kind: 'warn';
      readonly thresholdDays: number;
      readonly boundary: Temporal.Instant;
    };

/** The Market's warning settings (design 5.1: `warningThresholdsDays`, `renewalSubmitByDays`). */
export interface ExpiryPolicy {
  readonly warningThresholdsDays: readonly number[];
  readonly renewalSubmitByDays: number;
}

export const MAX_WARNING_THRESHOLD_DAYS = 366;

/**
 * The selection window's margin (data design A9): the largest gap between the zone at approval
 * and any current zone (UTC-12 to UTC+14), so a record whose exact boundary in a current zone is
 * earlier than the stored one is still selected; the exact boundary is computed per record.
 */
export const ZONE_MARGIN_HOURS = 26;

/** A policy that cannot be used: the start-up stops. */
export class ExpiryPolicyError extends Error {
  override readonly name = 'ExpiryPolicyError';
}

export function assertExpiryPolicy(policy: ExpiryPolicy, where: string): void {
  const seen = new Set<number>();
  for (const days of policy.warningThresholdsDays) {
    if (!Number.isInteger(days) || days < 1 || days > MAX_WARNING_THRESHOLD_DAYS) {
      throw new ExpiryPolicyError(`${where}: warning threshold ${days} is not 1 to 366 days`);
    }
    if (seen.has(days)) throw new ExpiryPolicyError(`${where}: warning threshold ${days} twice`);
    seen.add(days);
  }
  const submitBy = policy.renewalSubmitByDays;
  if (!Number.isInteger(submitBy) || submitBy < 0 || submitBy > MAX_WARNING_THRESHOLD_DAYS) {
    throw new ExpiryPolicyError(`${where}: renewalSubmitByDays is not 0 to 366`);
  }
}

/**
 * The latest stored boundary the job selects at `now`: 26 hours plus the largest threshold, so
 * every record whose expiry or warning may be due is a candidate (data design A9).
 */
export function candidateHorizon(
  now: Temporal.Instant,
  thresholds: readonly number[] | null,
): Temporal.Instant {
  const largest = thresholds === null || thresholds.length === 0 ? 0 : Math.max(...thresholds);
  return now.add({ hours: ZONE_MARGIN_HOURS + 24 * largest });
}

/** The date by which a renewal should be submitted (brief s4 c 2; design 5.1). */
export function renewalSubmitBy(
  expiryDate: Temporal.PlainDate,
  renewalSubmitByDays: number,
): Temporal.PlainDate {
  return expiryDate.subtract({ days: renewalSubmitByDays });
}

/**
 * The boundary the job acts on (design 2.4 rule 2, 8.6): the earliest of the boundary stored at
 * approval and the boundary in each current approved zone that is usable, so the status never
 * lags the claim and never runs ahead of it. Without usable current zones only the stored
 * boundary counts: the claim already answers "no" for such a seller (`seller-zone-missing`), and
 * a terminal-looking status written before the real boundary would be wrong for the record.
 * Null when there is no expiry to act on.
 */
export function jobBoundary(facts: ExpiryFacts, zones: CurrentZones | null): JobBoundary | null {
  if (!facts.requiresExpiry || facts.expiryDate === null) return null;
  const candidates: JobBoundary[] = [];
  // On a tie the current zones are named first, as the claim does (validity.ts).
  for (const zone of [zones?.zone, zones?.addressZone]) {
    if (isUsableZone(zone)) {
      candidates.push({ at: expiryBoundary(facts.expiryDate, zone), zone });
    }
  }
  const approvalZone = isUsableZone(facts.zoneAtApproval) ? facts.zoneAtApproval : null;
  if (facts.storedBoundary !== null) {
    candidates.push({ at: facts.storedBoundary, zone: approvalZone });
  } else if (approvalZone !== null) {
    candidates.push({ at: expiryBoundary(facts.expiryDate, approvalZone), zone: approvalZone });
  }
  let earliest: JobBoundary | null = null;
  for (const candidate of candidates) {
    if (earliest === null || Temporal.Instant.compare(candidate.at, earliest.at) < 0) {
      earliest = candidate;
    }
  }
  return earliest;
}

/**
 * The start of the seller's local day `thresholdDays` before the boundary's day (CERT-14): for
 * an expiry date D the boundary is the start of D + 1, so the 1-day warning starts at 00:00 of D.
 * Computed in the zone that gave the boundary, DST-safe as a start of day. Without a zone the
 * stored instant is all there is, and whole 24-hour days are counted back from it.
 */
export function warningStart(boundary: JobBoundary, thresholdDays: number): Temporal.Instant {
  if (boundary.zone === null) return boundary.at.subtract({ hours: 24 * thresholdDays });
  return boundary.at
    .toZonedDateTimeISO(boundary.zone)
    .toPlainDate()
    .subtract({ days: thresholdDays })
    .toZonedDateTime(boundary.zone)
    .toInstant();
}

/**
 * What the job does with one record at `at` (design 8.6): only an `approved` record with an
 * expiry moves. Past the boundary it expires. Before it, the most urgent threshold whose local
 * day has started is warned once (one marker per submission and threshold, AC 9); when several
 * fall due together (approved close to expiry) only the most urgent is sent and the others never
 * are. Without a policy (`thresholds` null) nobody is warned and expiry still happens.
 */
export function expiryActionAt(
  facts: ExpiryFacts,
  zones: CurrentZones | null,
  thresholds: readonly number[] | null,
  at: Temporal.Instant,
): ExpiryAction {
  if (facts.status !== 'approved') return { kind: 'none' };
  const boundary = jobBoundary(facts, zones);
  if (boundary === null) return { kind: 'none' };
  if (Temporal.Instant.compare(at, boundary.at) >= 0) {
    return { kind: 'expire', boundary: boundary.at };
  }
  if (thresholds === null) return { kind: 'none' };
  let due: number | null = null;
  for (const days of thresholds) {
    if (Temporal.Instant.compare(at, warningStart(boundary, days)) >= 0) {
      if (due === null || days < due) due = days;
    }
  }
  if (due === null || facts.warnedThresholds.includes(due)) return { kind: 'none' };
  return { kind: 'warn', thresholdDays: due, boundary: boundary.at };
}
