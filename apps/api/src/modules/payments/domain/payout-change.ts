import { Temporal } from '@mondapac/shared-kernel';

// The bank-change waiting period (VER-10 cooling-off, HP-1 option 2 payout pause, simplified).
// Pure rules over instants; the callers pass the instants they read from the injected Clock.

/** What happened to the seller's payout destination, never which bank or account. */
export const CHANGE_KINDS = ['initial', 'added', 'updated', 'removed'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** The Connect events that report a change of the payout destination. */
export const EXTERNAL_ACCOUNT_EVENT_TYPES = [
  'account.external_account.created',
  'account.external_account.updated',
  'account.external_account.deleted',
] as const;
export type ExternalAccountEventType = (typeof EXTERNAL_ACCOUNT_EVENT_TYPES)[number];

export const isExternalAccountEvent = (type: string): type is ExternalAccountEventType =>
  (EXTERNAL_ACCOUNT_EVENT_TYPES as readonly string[]).includes(type);

export const MIN_COOLING_OFF_HOURS = 24;
export const MAX_COOLING_OFF_HOURS = 14 * 24;

/**
 * The Market's cooling-off length in hours, clamped to 24 h to 14 d. A missing or invalid value is
 * the longest (14 d): the stricter rule wins.
 */
export function clampCoolingOffHours(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return MAX_COOLING_OFF_HOURS;
  return Math.min(MAX_COOLING_OFF_HOURS, Math.max(MIN_COOLING_OFF_HOURS, Math.ceil(raw)));
}

/** What is known about the account when an external-account event is applied. */
export interface ChangeContext {
  /** A change (or the migration's marker) is recorded for the account already. */
  readonly hasEarlierChange: boolean;
  /** The stored account never had payouts enabled (read before this event's own read). */
  readonly neverEnabled: boolean;
  /** How many external accounts Stripe lists now; null when the read did not say. */
  readonly externalAccountCount: number | null;
}

/**
 * The kind of a change. `initial` (no waiting period) only for the onboarding: a `created` event
 * with no change recorded, an account that never had payouts enabled, and exactly one external
 * account at Stripe now. Anything else, including an unknown count, is a real change.
 */
export function kindOf(type: ExternalAccountEventType, known: ChangeContext): ChangeKind {
  if (type === 'account.external_account.created') {
    const onboarding =
      !known.hasEarlierChange && known.neverEnabled && known.externalAccountCount === 1;
    return onboarding ? 'initial' : 'added';
  }
  return type === 'account.external_account.updated' ? 'updated' : 'removed';
}

/** The later of two optional instants. */
export function laterOf(
  a: Temporal.Instant | null,
  b: Temporal.Instant | null,
): Temporal.Instant | null {
  if (a === null) return b;
  if (b === null) return a;
  return Temporal.Instant.compare(a, b) >= 0 ? a : b;
}

/**
 * The cooling-off end after a change: none for `initial`, otherwise `detectedAt + hours`, never
 * earlier than a value already stored.
 */
export function coolingOffAfter(
  kind: ChangeKind,
  detectedAt: Temporal.Instant,
  hours: number,
  existing: Temporal.Instant | null,
): Temporal.Instant | null {
  if (kind === 'initial') return existing;
  return laterOf(existing, detectedAt.add(Temporal.Duration.from({ hours })));
}

/** True while `until` is in the future. */
export const isCoolingOff = (until: Temporal.Instant | null, now: Temporal.Instant): boolean =>
  until !== null && Temporal.Instant.compare(until, now) > 0;

/** The payout schedule an account should have now: manual while paused, else the Market's own. */
export type DesiredSchedule = 'manual' | 'normal';

export const desiredSchedule = (
  pausedUntil: Temporal.Instant | null,
  now: Temporal.Instant,
): DesiredSchedule => (isCoolingOff(pausedUntil, now) ? 'manual' : 'normal');

/** The Idempotency-Key of a schedule write; a re-pause after a seller undid it has a new one. */
export function scheduleKey(
  action: 'pause' | 'resume',
  changeId: string,
  revision: number,
): string {
  return `payout-${action}:${changeId}${revision > 0 ? `:r${revision}` : ''}`;
}
