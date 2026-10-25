import { inputOf, minorOf } from '../shipping/money.ts';
import {
  MAX_DAYS,
  MIN_DAYS,
  type DeliverySettings,
  type Margin,
  type MarginKind,
  type Method,
} from './types.ts';

/** What the page holds: texts for the numbers so a half-typed value is not lost. */
export interface SettingsForm {
  readonly enabled: Readonly<Record<Method, boolean>>;
  readonly cutoff: string;
  readonly daysAhead: string;
  readonly windowMinutes: string;
  readonly marginKind: MarginKind;
  /** Percent as typed ("12.5") or a fixed amount in major units ("1.50"). */
  readonly marginValue: string;
  readonly roundingStep: string;
}

export type FormField = 'cutoff' | 'daysAhead' | 'marginValue';

const MAX_FIXED_MINOR = 1_000_000;
const MAX_BASIS_POINTS = 10_000;

/** A percent as typed, from basis points: 1250 is "12.5", 1000 is "10". */
export function percentText(basisPoints: number): string {
  const whole = Math.floor(basisPoints / 100);
  const fraction = String(basisPoints % 100)
    .padStart(2, '0')
    .replace(/0$/, '');
  return basisPoints % 100 === 0 ? String(whole) : `${whole}.${fraction}`;
}

/** Basis points from a percent text ("10", "12.5", "0.25"; at most two decimals, 0 to 100), or null. */
export function basisPointsOf(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (match === null) return null;
  const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return basisPoints <= MAX_BASIS_POINTS ? basisPoints : null;
}

export function formOf(settings: DeliverySettings): SettingsForm {
  const { margin } = settings;
  return {
    enabled: settings.enabled,
    cutoff: settings.sameDayCutoff,
    daysAhead: String(settings.scheduledDaysAhead),
    windowMinutes: String(settings.scheduledWindowMinutes),
    marginKind: margin.kind,
    marginValue:
      margin.kind === 'percent'
        ? percentText(margin.basisPoints ?? 0)
        : margin.kind === 'fixed'
          ? inputOf(String(margin.amountMinor ?? 0), settings.currency)
          : '',
    roundingStep: String(settings.roundingStepMinor),
  };
}

/** The margin of the form, or null when its amount is not valid. */
export function marginOf(form: SettingsForm, currency: string): Margin | null {
  if (form.marginKind === 'none') return { kind: 'none' };
  if (form.marginKind === 'percent') {
    const basisPoints = basisPointsOf(form.marginValue);
    return basisPoints === null ? null : { kind: 'percent', basisPoints };
  }
  const amountMinor = minorOf(form.marginValue, currency);
  return amountMinor === null || amountMinor > MAX_FIXED_MINOR
    ? null
    : { kind: 'fixed', amountMinor };
}

export type Checked =
  | {
      readonly ok: true;
      readonly body: Omit<
        DeliverySettings,
        'version' | 'currency' | 'marketZone' | 'roundingSteps'
      >;
    }
  | { readonly ok: false; readonly invalid: readonly FormField[] };

/** The body to send, or the fields to flag. The API checks all of it again. */
export function checkForm(form: SettingsForm, currency: string): Checked {
  const invalid: FormField[] = [];
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.cutoff)) invalid.push('cutoff');
  const days = /^\d{1,2}$/.test(form.daysAhead.trim()) ? Number(form.daysAhead) : NaN;
  if (!(days >= MIN_DAYS && days <= MAX_DAYS)) invalid.push('daysAhead');
  const margin = marginOf(form, currency);
  if (margin === null) invalid.push('marginValue');
  if (invalid.length > 0 || margin === null) return { ok: false, invalid };
  return {
    ok: true,
    body: {
      enabled: form.enabled,
      sameDayCutoff: form.cutoff,
      scheduledDaysAhead: days,
      scheduledWindowMinutes: Number(form.windowMinutes),
      margin,
      roundingStepMinor: Number(form.roundingStep),
    },
  };
}

/** The example quote of the page, in minor units of any currency: 12.34 in AUD, 1,234 in JPY. */
export const EXAMPLE_QUOTE_MINOR = 1234;

export interface Priced {
  readonly quote: number;
  readonly margin: number;
  readonly total: number;
}

/**
 * What the buyer pays for a fleet quote: the quote plus the margin (a percent rounded half-up to
 * a minor unit, or a fixed amount), then the total rounded up to the step. It mirrors
 * `applyDeliveryMargin` of the API, whole numbers only, so the example never differs from checkout.
 */
export function priceOf(quote: number, margin: Margin, roundingStep: number): Priced {
  const added =
    margin.kind === 'percent'
      ? Math.floor((quote * (margin.basisPoints ?? 0) + 5000) / 10_000)
      : margin.kind === 'fixed'
        ? (margin.amountMinor ?? 0)
        : 0;
  const before = quote + added;
  const total = Math.ceil(before / roundingStep) * roundingStep;
  return { quote, margin: total - quote, total };
}
