import type { ApiFailure } from '../api/client.ts';
import type {
  AssistantSettings,
  Audience,
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
  welcomeTextLength: 200,
});

/** Controls, invisible format characters, line separators and markup; U+200C stays allowed. */
const FORBIDDEN_TEXT = /(?!‌)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u;
const WHOLE = /^\d{1,7}$/;

export interface AssistantForm {
  readonly enabled: boolean;
  readonly audience: Audience;
  readonly audiencePercent: string;
  readonly scope: Scope;
  readonly users: UserGroup;
  readonly guestMessageLimit: string;
  readonly customerMessageLimit: string;
  readonly retention: Retention;
  readonly replyLanguage: ReplyLanguage;
  readonly supportHandoff: SupportHandoff;
  /** "Basket proposals from a list" switch; off by default. */
  readonly basketProposals: boolean;
  readonly welcomeText: string;
}

/** The fields that can be refused, named as the API names them. */
export type FieldKey =
  | 'audiencePercent'
  | 'scope'
  | 'guestMessageLimit'
  | 'customerMessageLimit'
  | 'supportHandoff'
  | 'welcomeText';

const FIELD_KEYS: readonly FieldKey[] = [
  'audiencePercent',
  'scope',
  'guestMessageLimit',
  'customerMessageLimit',
  'supportHandoff',
  'welcomeText',
];

export function formOf(settings: AssistantSettings): AssistantForm {
  return {
    enabled: settings.enabled,
    audience: settings.audience,
    audiencePercent: settings.audiencePercent === null ? '' : String(settings.audiencePercent),
    scope: settings.scope,
    users: settings.users,
    guestMessageLimit: String(settings.guestMessageLimit),
    customerMessageLimit: String(settings.customerMessageLimit),
    retention: settings.retention,
    replyLanguage: settings.replyLanguage,
    supportHandoff: settings.supportHandoff,
    basketProposals: settings.basketProposals,
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
      users: form.users,
      guestMessageLimit: guestMessageLimit!,
      customerMessageLimit: customerMessageLimit!,
      retention: form.retention,
      replyLanguage: form.replyLanguage,
      supportHandoff: form.supportHandoff,
      basketProposals: form.basketProposals,
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
