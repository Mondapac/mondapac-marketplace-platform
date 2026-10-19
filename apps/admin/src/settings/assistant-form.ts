import type { ApiFailure } from '../api/client.ts';
import type {
  AssistantSettings,
  Audience,
  ModelTier,
  ReplyLanguage,
  Retention,
  Scope,
  SupportHandoff,
  UserGroup,
} from './assistant-types.ts';

// The assistant settings form: text inputs as typed, checked with the same bounds the API checks
// (apps/api assistant-settings.ts), so most mistakes are named before a request is sent.

export const BOUNDS = Object.freeze({
  audiencePercent: { min: 1, max: 100 },
  guestMessageLimit: { min: 5, max: 60 },
  customerMessageLimit: { min: 5, max: 120 },
  dailySpendCapUsdCents: { min: 100, max: 100_000 },
  monthlySpendCapUsdCents: { min: 100, max: 2_000_000 },
  welcomeTextLength: 200,
});

/** Controls, invisible format characters, line separators and markup; U+200C stays allowed. */
const FORBIDDEN_TEXT = /(?!‌)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u;
const WHOLE = /^\d{1,7}$/;
const DOLLARS = /^(\d{1,5})(?:\.(\d{1,2}))?$/;

export interface AssistantForm {
  readonly enabled: boolean;
  readonly audience: Audience;
  readonly audiencePercent: string;
  readonly scope: Scope;
  readonly modelTier: ModelTier;
  readonly users: UserGroup;
  readonly guestMessageLimit: string;
  readonly customerMessageLimit: string;
  readonly retention: Retention;
  readonly replyLanguage: ReplyLanguage;
  /** US dollars, as typed. */
  readonly dailySpendCap: string;
  readonly monthlySpendCap: string;
  readonly supportHandoff: SupportHandoff;
  readonly welcomeText: string;
}

/** The fields that can be refused, named as the API names them. */
export type FieldKey =
  | 'audiencePercent'
  | 'scope'
  | 'guestMessageLimit'
  | 'customerMessageLimit'
  | 'dailySpendCapUsdCents'
  | 'monthlySpendCapUsdCents'
  | 'supportHandoff'
  | 'welcomeText';

const FIELD_KEYS: readonly FieldKey[] = [
  'audiencePercent',
  'scope',
  'guestMessageLimit',
  'customerMessageLimit',
  'dailySpendCapUsdCents',
  'monthlySpendCapUsdCents',
  'supportHandoff',
  'welcomeText',
];

/** "12.5" for 1250 cents; whole dollars drop the cents. */
export function dollarsOf(cents: number): string {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, '0')}`;
}

/** Cents of a typed dollar amount (no float arithmetic), or null when it is not one. */
export function centsOf(text: string): number | null {
  const match = DOLLARS.exec(text.trim());
  if (match === null) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

export function formOf(settings: AssistantSettings): AssistantForm {
  return {
    enabled: settings.enabled,
    audience: settings.audience,
    audiencePercent: settings.audiencePercent === null ? '' : String(settings.audiencePercent),
    scope: settings.scope,
    modelTier: settings.modelTier,
    users: settings.users,
    guestMessageLimit: String(settings.guestMessageLimit),
    customerMessageLimit: String(settings.customerMessageLimit),
    retention: settings.retention,
    replyLanguage: settings.replyLanguage,
    dailySpendCap: dollarsOf(settings.dailySpendCapUsdCents),
    monthlySpendCap: dollarsOf(settings.monthlySpendCapUsdCents),
    supportHandoff: settings.supportHandoff,
    welcomeText: settings.welcomeText ?? '',
  };
}

function wholeIn(text: string, bounds: { min: number; max: number }): number | null {
  const value = text.trim();
  if (!WHOLE.test(value)) return null;
  const number = Number(value);
  return number >= bounds.min && number <= bounds.max ? number : null;
}

export type FormCheck =
  | { readonly ok: true; readonly settings: AssistantSettings }
  | { readonly ok: false; readonly invalid: readonly FieldKey[] };

/** The settings to send, or the fields to fix. */
export function settingsOf(
  form: AssistantForm,
  unavailable: {
    readonly scope: readonly Scope[];
    readonly supportHandoff: readonly SupportHandoff[];
  },
): FormCheck {
  const invalid: FieldKey[] = [];
  let audiencePercent: number | null = null;
  if (form.audience === 'percent') {
    audiencePercent = wholeIn(form.audiencePercent, BOUNDS.audiencePercent);
    if (audiencePercent === null) invalid.push('audiencePercent');
  }
  if (unavailable.scope.includes(form.scope)) invalid.push('scope');
  const guestMessageLimit = wholeIn(form.guestMessageLimit, BOUNDS.guestMessageLimit);
  if (guestMessageLimit === null) invalid.push('guestMessageLimit');
  const customerMessageLimit = wholeIn(form.customerMessageLimit, BOUNDS.customerMessageLimit);
  if (customerMessageLimit === null) invalid.push('customerMessageLimit');
  const monthly = centsOf(form.monthlySpendCap);
  const monthlyOk =
    monthly !== null &&
    monthly >= BOUNDS.monthlySpendCapUsdCents.min &&
    monthly <= BOUNDS.monthlySpendCapUsdCents.max;
  if (!monthlyOk) invalid.push('monthlySpendCapUsdCents');
  const daily = centsOf(form.dailySpendCap);
  const dailyOk =
    daily !== null &&
    daily >= BOUNDS.dailySpendCapUsdCents.min &&
    daily <= BOUNDS.dailySpendCapUsdCents.max &&
    (!monthlyOk || daily <= monthly);
  if (!dailyOk) invalid.push('dailySpendCapUsdCents');
  if (unavailable.supportHandoff.includes(form.supportHandoff)) invalid.push('supportHandoff');
  const text = form.welcomeText.normalize('NFC').trim();
  if (FORBIDDEN_TEXT.test(text) || Array.from(text).length > BOUNDS.welcomeTextLength) {
    invalid.push('welcomeText');
  }
  if (invalid.length > 0) return { ok: false, invalid };
  return {
    ok: true,
    settings: {
      enabled: form.enabled,
      audience: form.audience,
      audiencePercent,
      scope: form.scope,
      modelTier: form.modelTier,
      users: form.users,
      guestMessageLimit: guestMessageLimit!,
      customerMessageLimit: customerMessageLimit!,
      retention: form.retention,
      replyLanguage: form.replyLanguage,
      dailySpendCapUsdCents: daily!,
      monthlySpendCapUsdCents: monthly!,
      supportHandoff: form.supportHandoff,
      welcomeText: text === '' ? null : text,
    },
  };
}

const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'assistant.conflict': 'conflict',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
  'access.denied': 'denied',
};

/** The message key (under `settings.assistant.error`) for a failed write. */
export function assistantProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}

/** The fields a `validation.failed` answer names, among those the form shows. */
export function refusedFields(failure: ApiFailure): readonly FieldKey[] {
  return (failure.details?.fields ?? [])
    .map((field) => field.path)
    .filter((path): path is FieldKey => (FIELD_KEYS as readonly string[]).includes(path));
}
