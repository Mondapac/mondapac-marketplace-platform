import { err, ok } from '@mondapac/shared-kernel';
import type { Temporal } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
// Payout terms (Phase 5 package 6b; G2 4.4, 3.2). The Market's terms come from Market config
// (`commissionPayouts.payoutTerms`, no core default); an admin may override some of them for one
// seller (nullable fields fall back to the Market's). The hold bounds are platform-wide code
// constants, enforced in the config schema, on write, on read and as database CHECKs.

/**
 * The platform-wide bounds of a hold, in days (G2 4.4): code constants, not Market values. The
 * Market config schema (platform/market-config) and the database CHECKs carry the same numbers;
 * a test asserts that they agree.
 */
export const MIN_HOLD_DAYS = 7;
export const MAX_HOLD_DAYS = 60;

export const PAYOUT_WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type PayoutWeekday = (typeof PAYOUT_WEEKDAYS)[number];

export const APPROVAL_MODES = ['AUTO', 'MANUAL'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** Who confirmed a delivery: the carrier's booking, or the seller's click. */
export const ANCHOR_SOURCES = ['carrier', 'seller-click'] as const;
export type AnchorSource = (typeof ANCHOR_SOURCES)[number];

/** The terms in force for a seller: the Market's values with the seller's override over them. */
export interface PayoutTerms {
  readonly weekdays: readonly PayoutWeekday[];
  /** HH:mm in the seller's own zone. */
  readonly localTime: string;
  readonly holdDaysCarrier: number;
  readonly holdDaysSellerClick: number;
  /** Minor units of the Market currency. */
  readonly minimumMinor: bigint;
  readonly approvalMode: ApprovalMode;
  /** Market config only; the payout run (package 6d) acts on it. */
  readonly firstPayoutManual: boolean;
}

/** What an admin may set for one seller; `null` means the Market's value. */
export interface PayoutTermsOverride {
  readonly weekdays: readonly PayoutWeekday[] | null;
  readonly localTime: string | null;
  readonly holdDaysCarrier: number | null;
  readonly holdDaysSellerClick: number | null;
  readonly minimumMinor: bigint | null;
  readonly approvalMode: ApprovalMode | null;
}

export const isHoldDays = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= MIN_HOLD_DAYS &&
  value <= MAX_HOLD_DAYS;

const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ---------------------------------------------------------------------------------------------
// Storage forms: a weekday bitmask (bit 0 = Monday) and the minute of the local day.

export function weekdaysToMask(weekdays: readonly PayoutWeekday[]): number {
  return weekdays.reduce((mask, day) => mask | (1 << PAYOUT_WEEKDAYS.indexOf(day)), 0);
}

export function maskToWeekdays(mask: number): readonly PayoutWeekday[] {
  return PAYOUT_WEEKDAYS.filter((_, index) => (mask & (1 << index)) !== 0);
}

export function localTimeToMinute(localTime: string): number | null {
  const match = LOCAL_TIME.exec(localTime);
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

export function minuteToLocalTime(minute: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

// ---------------------------------------------------------------------------------------------
// The Market's terms, from Market config.

export interface MarketPayoutTermsConfig {
  readonly weekdays: readonly PayoutWeekday[];
  readonly localTime: string;
  readonly holdDaysCarrier: number;
  readonly holdDaysSellerClick: number;
  readonly minimumMinor: number;
  /** The most any minimum may be, the Market's and a seller's alike (minor units). */
  readonly minimumMinorCap: number;
  readonly approvalMode: ApprovalMode;
  readonly firstPayoutManual: boolean;
}

export type TermsUnavailable = { readonly code: 'commission-payouts.terms-unavailable' };

/**
 * The terms in force: the Market's with the seller's override over them. Checked on read: no
 * Market terms, or any resulting value outside its bounds, makes the terms unavailable (fail
 * closed; nothing is anchored or paid on them).
 */
export function resolvePayoutTerms(
  market: MarketPayoutTermsConfig | null,
  override: PayoutTermsOverride | null,
): Result<PayoutTerms, TermsUnavailable> {
  const unavailable = err<TermsUnavailable>({ code: 'commission-payouts.terms-unavailable' });
  if (market === null) return unavailable;
  const terms: PayoutTerms = {
    weekdays: override?.weekdays ?? market.weekdays,
    localTime: override?.localTime ?? market.localTime,
    holdDaysCarrier: override?.holdDaysCarrier ?? market.holdDaysCarrier,
    holdDaysSellerClick: override?.holdDaysSellerClick ?? market.holdDaysSellerClick,
    minimumMinor: override?.minimumMinor ?? BigInt(market.minimumMinor),
    approvalMode: override?.approvalMode ?? market.approvalMode,
    firstPayoutManual: market.firstPayoutManual,
  };
  const valid =
    isHoldDays(terms.holdDaysCarrier) &&
    isHoldDays(terms.holdDaysSellerClick) &&
    terms.minimumMinor >= 1n &&
    terms.minimumMinor <= BigInt(Math.min(market.minimumMinorCap, Number.MAX_SAFE_INTEGER)) &&
    terms.weekdays.length >= 1 &&
    localTimeToMinute(terms.localTime) !== null;
  return valid ? ok(terms) : unavailable;
}

// ---------------------------------------------------------------------------------------------
// An admin's input.

export interface FieldProblem {
  readonly path: string;
  readonly code: string;
}

type OverrideKey =
  | 'weekdays'
  | 'localTime'
  | 'holdDaysCarrier'
  | 'holdDaysSellerClick'
  | 'minimumMinor'
  | 'approvalMode';

/**
 * The override from the wire. Each field is absent or null (the Market's value) or a valid value;
 * at least one must be set. `minimumMinor` is a whole number of minor units of the Market
 * currency, at least 1.
 */
export function parsePayoutTermsOverride(
  input: unknown,
  minimumMinorCap: bigint,
): Result<PayoutTermsOverride, readonly FieldProblem[]> {
  const problems: FieldProblem[] = [];
  const raw: Record<string, unknown> =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (raw !== input) problems.push({ path: '', code: 'type' });
  const given = (key: OverrideKey) =>
    raw[key] === undefined || raw[key] === null ? undefined : raw[key];

  let weekdays: PayoutWeekday[] | null = null;
  const days = given('weekdays');
  if (days !== undefined) {
    const valid =
      Array.isArray(days) &&
      days.length >= 1 &&
      days.length <= 7 &&
      days.every((day) => PAYOUT_WEEKDAYS.includes(day as PayoutWeekday)) &&
      new Set(days).size === days.length;
    if (valid) weekdays = PAYOUT_WEEKDAYS.filter((day) => (days as string[]).includes(day));
    else problems.push({ path: 'weekdays', code: 'format' });
  }
  let localTime: string | null = null;
  const time = given('localTime');
  if (time !== undefined) {
    if (typeof time === 'string' && localTimeToMinute(time) !== null) localTime = time;
    else problems.push({ path: 'localTime', code: 'format' });
  }
  const hold = (key: 'holdDaysCarrier' | 'holdDaysSellerClick'): number | null => {
    const value = given(key);
    if (value === undefined) return null;
    if (isHoldDays(value)) return value;
    problems.push({ path: key, code: 'range' });
    return null;
  };
  const holdDaysCarrier = hold('holdDaysCarrier');
  const holdDaysSellerClick = hold('holdDaysSellerClick');
  let minimumMinor: bigint | null = null;
  const minimum = given('minimumMinor');
  if (minimum !== undefined) {
    if (
      typeof minimum === 'number' &&
      Number.isSafeInteger(minimum) &&
      minimum >= 1 &&
      BigInt(minimum) <= minimumMinorCap
    ) {
      minimumMinor = BigInt(minimum);
    } else problems.push({ path: 'minimumMinor', code: 'range' });
  }
  let approvalMode: ApprovalMode | null = null;
  const mode = given('approvalMode');
  if (mode !== undefined) {
    if (APPROVAL_MODES.includes(mode as ApprovalMode)) approvalMode = mode as ApprovalMode;
    else problems.push({ path: 'approvalMode', code: 'format' });
  }
  const override: PayoutTermsOverride = {
    weekdays,
    localTime,
    holdDaysCarrier,
    holdDaysSellerClick,
    minimumMinor,
    approvalMode,
  };
  if (problems.length === 0 && Object.values(override).every((value) => value === null)) {
    problems.push({ path: '', code: 'empty' });
  }
  return problems.length > 0 ? err(problems) : ok(override);
}

/** Whether a stored override is inside the bounds (checked on read; a CHECK also holds). */
export const overrideInBounds = (override: PayoutTermsOverride, minimumMinorCap: bigint): boolean =>
  (override.holdDaysCarrier === null || isHoldDays(override.holdDaysCarrier)) &&
  (override.holdDaysSellerClick === null || isHoldDays(override.holdDaysSellerClick)) &&
  (override.minimumMinor === null ||
    (override.minimumMinor >= 1n && override.minimumMinor <= minimumMinorCap));

// ---------------------------------------------------------------------------------------------
// The eligibility anchor.

export const holdDaysFor = (source: AnchorSource, terms: PayoutTerms): number =>
  source === 'carrier' ? terms.holdDaysCarrier : terms.holdDaysSellerClick;

/**
 * The instant a delivered seller order's money becomes eligible: the delivery plus the hold, in
 * exact 24-hour days, computed on the instant (never on a local calendar, never with `Date`).
 */
export const eligibleAtOf = (deliveredAt: Temporal.Instant, holdDays: number): Temporal.Instant =>
  deliveredAt.add({ hours: holdDays * 24 });

// ---------------------------------------------------------------------------------------------
// Why an admin changed a seller's terms.

/** The closed list of reasons an admin gives when setting or removing a seller's terms. */
export const TERMS_CHANGE_REASONS = [
  'seller-request',
  'risk-review',
  'correction',
  'policy',
] as const;
export type TermsChangeReason = (typeof TERMS_CHANGE_REASONS)[number];

export const isTermsChangeReason = (value: unknown): value is TermsChangeReason =>
  typeof value === 'string' && TERMS_CHANGE_REASONS.includes(value as TermsChangeReason);
