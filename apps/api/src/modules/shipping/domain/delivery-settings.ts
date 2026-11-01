import { Temporal } from '@mondapac/shared-kernel';
import { DELIVERY_METHODS, isDeliveryMethod, type DeliveryMethod } from './delivery-methods';
import { NO_MARGIN, parseDeliveryPricing, type DeliveryPricing } from './delivery-margin';

// Delivery settings of a Market and the rules that turn them into "may this seller deliver this
// way now" (delivery models, package 4). Owner decisions: an admin switches each method on or off
// for the whole Market; a method that is off is unavailable to every seller. Same-day has a
// cut-off, a local time that defaults to 12:00 and is read in the zone of the seller (the Market
// zone is only the fallback; ADR-0005). A scheduled delivery is picked at most N days ahead
// (start 7) in windows of one fixed length (start 2 hours). Time comes in as an instant (the
// injected Clock) and a zone id; nothing here reads the system clock.

export const MIN_SCHEDULED_DAYS_AHEAD = 1;
export const MAX_SCHEDULED_DAYS_AHEAD = 30;
export const MIN_WINDOW_MINUTES = 30;
export const MAX_WINDOW_MINUTES = 480;
/** The window length moves in steps of this many minutes. */
export const WINDOW_STEP_MINUTES = 15;
/**
 * Minutes the Market gives a seller to get a paid order ready (seller health, late ready): the
 * promised ready-by time is the payment time plus this, or the window start of a scheduled order.
 */
export const MIN_READY_PREP_MINUTES = 5;
export const MAX_READY_PREP_MINUTES = 2880;
export const DEFAULT_READY_PREP_MINUTES = 60;
/** The default cut-off: 12:00 local time, as minutes after midnight. */
export const DEFAULT_SAME_DAY_CUTOFF_MINUTES = 12 * 60;

export interface DeliverySettings extends DeliveryPricing {
  /** Which methods are on for the whole Market. */
  readonly enabled: Readonly<Record<DeliveryMethod, boolean>>;
  /** Minutes after local midnight (0 to 1439) up to which a same-day order is accepted. */
  readonly sameDayCutoffMinutes: number;
  readonly scheduledDaysAhead: number;
  readonly scheduledWindowMinutes: number;
  /** Minutes a seller has to get a paid order ready (5 to 2880). */
  readonly readyPrepMinutes: number;
  /** Rises with each save; 0 while the Market has never saved (the defaults apply). */
  readonly version: number;
}

/**
 * What a Market has before an admin saves anything: every method on (as before these settings
 * existed), a 12:00 same-day cut-off, 7 days ahead, 2-hour windows and no margin.
 */
export const DEFAULT_DELIVERY_SETTINGS: DeliverySettings = Object.freeze({
  enabled: Object.freeze({ pickup: true, instant: true, same_day: true, scheduled: true }),
  sameDayCutoffMinutes: DEFAULT_SAME_DAY_CUTOFF_MINUTES,
  scheduledDaysAhead: 7,
  scheduledWindowMinutes: 120,
  readyPrepMinutes: DEFAULT_READY_PREP_MINUTES,
  ...NO_MARGIN,
  version: 0,
});

/** `HH:MM` of minutes after midnight. */
export const formatCutoff = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const CUTOFF = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/** Minutes after midnight of an `HH:MM` string, or null. */
export function parseCutoff(value: unknown): number | null {
  const match = typeof value === 'string' ? CUTOFF.exec(value) : null;
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

type Field = { readonly path: string; readonly code: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const KEYS = [
  'enabled',
  'sameDayCutoff',
  'scheduledDaysAhead',
  'scheduledWindowMinutes',
  'readyPrepMinutes',
  'margin',
  'roundingStepMinor',
  'expectedVersion',
] as const;

export type DeliverySettingsInput = Omit<DeliverySettings, 'version'>;

/** What an admin sent: `readyPrepMinutes` is null when the key was left out (keep the saved value). */
export type ParsedDeliverySettings = Omit<DeliverySettingsInput, 'readyPrepMinutes'> & {
  readonly readyPrepMinutes: number | null;
};

/**
 * Parses the settings an admin saves (the whole set: `enabled` per method, `sameDayCutoff` as
 * `HH:MM`, `scheduledDaysAhead`, `scheduledWindowMinutes`, `margin`, `roundingStepMinor`). The
 * `expectedVersion` is read by the caller. A missing or unknown key and a value out of range are
 * refused whole, naming each path.
 */
export function parseDeliverySettings(
  input: unknown,
):
  | { readonly ok: true; readonly value: ParsedDeliverySettings }
  | { readonly ok: false; readonly fields: Field[] } {
  if (!isObject(input)) return { ok: false, fields: [{ path: '', code: 'type' }] };
  const fields: Field[] = [];
  const unknown = Object.keys(input).find((key) => !(KEYS as readonly string[]).includes(key));
  if (unknown !== undefined) fields.push({ path: 'field', code: 'unknown-field' });

  const enabledRaw = input.enabled;
  const enabled: Partial<Record<DeliveryMethod, boolean>> = {};
  if (!isObject(enabledRaw)) fields.push({ path: 'enabled', code: 'type' });
  else {
    for (const key of Object.keys(enabledRaw)) {
      if (!isDeliveryMethod(key)) fields.push({ path: 'enabled.field', code: 'unknown-field' });
    }
    for (const method of DELIVERY_METHODS) {
      const value = enabledRaw[method];
      if (typeof value === 'boolean') enabled[method] = value;
      else fields.push({ path: `enabled.${method}`, code: 'type' });
    }
  }
  const cutoff = parseCutoff(input.sameDayCutoff);
  if (cutoff === null) fields.push({ path: 'sameDayCutoff', code: 'format' });
  const days = input.scheduledDaysAhead;
  if (
    typeof days !== 'number' ||
    !Number.isInteger(days) ||
    days < MIN_SCHEDULED_DAYS_AHEAD ||
    days > MAX_SCHEDULED_DAYS_AHEAD
  ) {
    fields.push({ path: 'scheduledDaysAhead', code: 'range' });
  }
  const length = input.scheduledWindowMinutes;
  if (
    typeof length !== 'number' ||
    !Number.isInteger(length) ||
    length < MIN_WINDOW_MINUTES ||
    length > MAX_WINDOW_MINUTES ||
    length % WINDOW_STEP_MINUTES !== 0
  ) {
    fields.push({ path: 'scheduledWindowMinutes', code: 'range' });
  }
  const prepRaw = input.readyPrepMinutes;
  let prep: number | null = null;
  if (prepRaw !== undefined) {
    if (
      typeof prepRaw !== 'number' ||
      !Number.isInteger(prepRaw) ||
      prepRaw < MIN_READY_PREP_MINUTES ||
      prepRaw > MAX_READY_PREP_MINUTES
    ) {
      fields.push({ path: 'readyPrepMinutes', code: 'range' });
    } else prep = prepRaw;
  }
  const pricing = parseDeliveryPricing({
    margin: input.margin,
    roundingStepMinor: input.roundingStepMinor,
  });
  if (!pricing.ok) fields.push(...pricing.fields);
  if (
    fields.length > 0 ||
    cutoff === null ||
    typeof days !== 'number' ||
    typeof length !== 'number' ||
    !pricing.ok
  ) {
    return { ok: false, fields };
  }
  return {
    ok: true,
    value: {
      enabled: Object.freeze({
        pickup: enabled.pickup === true,
        instant: enabled.instant === true,
        same_day: enabled.same_day === true,
        scheduled: enabled.scheduled === true,
      }),
      sameDayCutoffMinutes: cutoff,
      scheduledDaysAhead: days,
      scheduledWindowMinutes: length,
      readyPrepMinutes: prep,
      ...pricing.value,
    },
  };
}

/** The methods a list of strings names, each once, or null if one is not a method. */
export function parseMethodSet(input: unknown): readonly DeliveryMethod[] | null {
  if (!Array.isArray(input) || input.length > DELIVERY_METHODS.length) return null;
  if (!input.every(isDeliveryMethod)) return null;
  const set = new Set<DeliveryMethod>(input);
  return DELIVERY_METHODS.filter((method) => set.has(method));
}

// ---------------------------------------------------------------------------------------------
// Availability

/**
 * Why a method is not available: `platform-off` (the Market switched it off), `seller-unsupported`
 * (an admin did not give it to this seller), `past-cut-off` (same day, after today's cut-off in the
 * seller's zone), `no-pickup-address` (pickup, but no approved pickup address).
 */
export type UnavailableReason =
  'platform-off' | 'seller-unsupported' | 'past-cut-off' | 'no-pickup-address';

export type MethodAvailability =
  | { readonly method: DeliveryMethod; readonly available: true; readonly reason: null }
  | {
      readonly method: DeliveryMethod;
      readonly available: false;
      readonly reason: UnavailableReason;
    };

/** What an availability read needs of one seller at one moment. */
export interface AvailabilityFacts {
  readonly settings: DeliverySettings;
  /** The methods an admin took away from this seller (empty: the seller has every method). */
  readonly sellerUnsupported: ReadonlySet<DeliveryMethod>;
  readonly hasPickupAddress: boolean;
  readonly now: Temporal.Instant;
  /** The IANA zone of the seller (or the Market's, as the fallback). */
  readonly zone: string;
}

const plainTimeOf = (minutes: number): Temporal.PlainTime =>
  new Temporal.PlainTime(Math.floor(minutes / 60), minutes % 60);

/**
 * Whether `now` is before the same-day cut-off of the day it is in `zone`: wall-clock time in
 * the zone, so a daylight-saving change moves the instant but not the local cut-off.
 */
export function isBeforeSameDayCutoff(
  now: Temporal.Instant,
  zone: string,
  cutoffMinutes: number,
): boolean {
  const local = now.toZonedDateTimeISO(zone).toPlainTime();
  return Temporal.PlainTime.compare(local, plainTimeOf(cutoffMinutes)) < 0;
}

/**
 * The four methods in the fixed order, each with its verdict. Order of reasons: the Market's
 * switch first, then the seller's, then the structural rule of the method.
 */
export function evaluateMethods(facts: AvailabilityFacts): readonly MethodAvailability[] {
  return DELIVERY_METHODS.map((method): MethodAvailability => {
    if (!facts.settings.enabled[method]) return refused(method, 'platform-off');
    if (facts.sellerUnsupported.has(method)) return refused(method, 'seller-unsupported');
    if (method === 'pickup' && !facts.hasPickupAddress) return refused(method, 'no-pickup-address');
    if (
      method === 'same_day' &&
      !isBeforeSameDayCutoff(facts.now, facts.zone, facts.settings.sameDayCutoffMinutes)
    ) {
      return refused(method, 'past-cut-off');
    }
    return { method, available: true, reason: null };
  });
}

const refused = (method: DeliveryMethod, reason: UnavailableReason): MethodAvailability => ({
  method,
  available: false,
  reason,
});

export type WindowRefusal = 'window-in-past' | 'window-too-far' | 'window-length';

/**
 * Whether a scheduled window is one the Market offers: it starts after `now`, on a local date at
 * most `scheduledDaysAhead` days after today in `zone`, and lasts exactly the configured length.
 * Instants in, a reason out; calendar arithmetic is done in the zone, never on raw milliseconds.
 */
export function checkScheduledWindow(
  window: { readonly start: Temporal.Instant; readonly end: Temporal.Instant },
  settings: Pick<DeliverySettings, 'scheduledDaysAhead' | 'scheduledWindowMinutes'>,
  now: Temporal.Instant,
  zone: string,
): WindowRefusal | null {
  if (Temporal.Instant.compare(window.start, now) <= 0) return 'window-in-past';
  const today = now.toZonedDateTimeISO(zone).toPlainDate();
  const lastDay = today.add({ days: settings.scheduledDaysAhead });
  if (
    Temporal.PlainDate.compare(window.start.toZonedDateTimeISO(zone).toPlainDate(), lastDay) > 0
  ) {
    return 'window-too-far';
  }
  const length = window.end.epochMilliseconds - window.start.epochMilliseconds;
  return length === settings.scheduledWindowMinutes * 60_000 ? null : 'window-length';
}

/** A buyer's choice of one seller order, as a policy check takes it. */
export interface DeliveryChoiceFacts {
  readonly method: DeliveryMethod;
  readonly window: { readonly start: Temporal.Instant; readonly end: Temporal.Instant } | null;
}

export type ChoiceRefusal = UnavailableReason | WindowRefusal | 'window-missing';

/** The verdict of a choice: available now for the seller and, for scheduled, a window on offer. */
export function checkChoice(
  facts: AvailabilityFacts,
  choice: DeliveryChoiceFacts,
): ChoiceRefusal | null {
  const verdict = evaluateMethods(facts).find((entry) => entry.method === choice.method);
  if (verdict === undefined) return 'platform-off';
  if (!verdict.available) return verdict.reason;
  if (choice.method !== 'scheduled') return null;
  if (choice.window === null) return 'window-missing';
  return checkScheduledWindow(choice.window, facts.settings, facts.now, facts.zone);
}

/**
 * What a read answers for one seller at one moment: the four methods with the reason for each
 * that is unavailable, the zone the rules were read in, and the numbers a screen shows ("same-day
 * orders close at 12:00", "pick a window up to 7 days ahead"). The reasons are codes; the words
 * are the client's.
 */
export interface SellerDeliveryAvailability {
  readonly sellerId: string;
  readonly zone: string;
  readonly methods: readonly MethodAvailability[];
  /** `HH:MM`, local time in `zone`. */
  readonly sameDayCutoff: string;
  readonly scheduledDaysAhead: number;
  readonly scheduledWindowMinutes: number;
}
