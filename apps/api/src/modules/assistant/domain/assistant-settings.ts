import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';

// The buyer assistant's per-Market settings (plan section 11): what a platform admin may tune.
// The guardrails (numbers only from server cards, certification only from evaluateClaim, no
// mutating tool, never payment, refunds, orders, addresses, accounts, discount codes or Cost) and
// the model API key are deliberately not settings. Every default is the recommended option, and
// the assistant ships off.

export const AUDIENCES = ['internal', 'percent', 'all'] as const;
export const SCOPES = ['read-only', 'cart-suggestions'] as const;
/** Model tiers; the provider model id of each tier is server configuration, never a setting. */
export const MODEL_TIERS = ['fast', 'balanced'] as const;
export const USER_GROUPS = ['guests-and-customers', 'customers-only'] as const;
export const RETENTIONS = ['none', '30-days', '12-months'] as const;
export const REPLY_LANGUAGES = ['buyer', 'english'] as const;
export const SUPPORT_HANDOFFS = ['email-link', 'in-panel-form'] as const;

export type Audience = (typeof AUDIENCES)[number];
export type Scope = (typeof SCOPES)[number];
export type ModelTier = (typeof MODEL_TIERS)[number];
export type UserGroup = (typeof USER_GROUPS)[number];
export type Retention = (typeof RETENTIONS)[number];
export type ReplyLanguage = (typeof REPLY_LANGUAGES)[number];
export type SupportHandoff = (typeof SUPPORT_HANDOFFS)[number];

/**
 * Options shown in the panel but not selectable yet: cart suggestions wait for cart PR 2 and
 * Hassan's review; the in-window support form waits for its own package.
 */
export const UNAVAILABLE_OPTIONS = Object.freeze({
  scope: ['cart-suggestions'] as readonly Scope[],
  supportHandoff: ['in-panel-form'] as readonly SupportHandoff[],
});

export interface AssistantSettings {
  /** The kill switch: off hides the assistant at once, without a release. */
  readonly enabled: boolean;
  readonly audience: Audience;
  /** 1 to 100 when `audience` is `percent`, else null. */
  readonly audiencePercent: number | null;
  readonly scope: Scope;
  readonly modelTier: ModelTier;
  readonly users: UserGroup;
  /** Messages a guest may send in 10 minutes. */
  readonly guestMessageLimit: number;
  /** Messages a signed-in customer may send in 10 minutes. */
  readonly customerMessageLimit: number;
  /** For signed-in customers; a guest's conversation is kept 30 days at most whatever this says. */
  readonly retention: Retention;
  readonly replyLanguage: ReplyLanguage;
  /** Provider spend caps, in US cents (the provider bills in US dollars). */
  readonly dailySpendCapUsdCents: number;
  readonly monthlySpendCapUsdCents: number;
  readonly supportHandoff: SupportHandoff;
  /** null: the storefront shows its own default welcome text. */
  readonly welcomeText: string | null;
}

export const SETTING_FIELDS = [
  'enabled',
  'audience',
  'audiencePercent',
  'scope',
  'modelTier',
  'users',
  'guestMessageLimit',
  'customerMessageLimit',
  'retention',
  'replyLanguage',
  'dailySpendCapUsdCents',
  'monthlySpendCapUsdCents',
  'supportHandoff',
  'welcomeText',
] as const satisfies readonly (keyof AssistantSettings)[];

/** Version 0: what is in force before an admin saves anything. */
export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = Object.freeze({
  enabled: false,
  audience: 'internal',
  audiencePercent: null,
  scope: 'read-only',
  modelTier: 'fast',
  users: 'guests-and-customers',
  guestMessageLimit: 20,
  customerMessageLimit: 40,
  retention: '30-days',
  replyLanguage: 'buyer',
  dailySpendCapUsdCents: 1_000,
  monthlySpendCapUsdCents: 20_000,
  supportHandoff: 'email-link',
  welcomeText: null,
});

export const BOUNDS = Object.freeze({
  audiencePercent: { min: 1, max: 100 },
  guestMessageLimit: { min: 5, max: 60 },
  customerMessageLimit: { min: 5, max: 120 },
  dailySpendCapUsdCents: { min: 100, max: 100_000 },
  monthlySpendCapUsdCents: { min: 100, max: 2_000_000 },
  welcomeTextLength: 200,
});

export interface FieldError {
  readonly path: string;
  readonly code: 'type' | 'range' | 'format' | 'unavailable';
}

// Controls, invisible format characters (bidirectional marks, overrides and isolates: a visual
// spoof), line and paragraph separators, and markup characters. The zero-width non-joiner
// (U+200C) stays allowed: Persian text needs it. The database CHECK repeats this list.
const FORBIDDEN_TEXT = /(?!\u200C)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u;

function oneOf<T extends string>(
  value: unknown,
  options: readonly T[],
  path: string,
  errors: FieldError[],
): T {
  if (typeof value === 'string' && (options as readonly string[]).includes(value))
    return value as T;
  errors.push({ path, code: 'type' });
  return options[0]!;
}

function integerIn(
  value: unknown,
  bounds: { min: number; max: number },
  path: string,
  errors: FieldError[],
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    errors.push({ path, code: 'type' });
    return bounds.min;
  }
  if (value < bounds.min || value > bounds.max) errors.push({ path, code: 'range' });
  return value;
}

/** The welcome text as stored: trimmed, NFC, 1 to 200 characters, or null for the default. */
export function parseWelcomeText(value: unknown): Result<string | null, FieldError> {
  if (value === null) return ok(null);
  if (typeof value !== 'string') return err({ path: 'welcomeText', code: 'type' });
  const text = value.normalize('NFC').trim();
  if (text.length === 0) return ok(null);
  if (FORBIDDEN_TEXT.test(text)) return err({ path: 'welcomeText', code: 'format' });
  if (Array.from(text).length > BOUNDS.welcomeTextLength) {
    return err({ path: 'welcomeText', code: 'range' });
  }
  return ok(text);
}

/** Validates a full settings object (every field required, no other key). */
export function parseAssistantSettings(
  input: unknown,
): Result<AssistantSettings, readonly FieldError[]> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return err([{ path: '', code: 'type' }]);
  }
  const raw = input as Record<string, unknown>;
  const errors: FieldError[] = [];

  const enabled = raw.enabled;
  if (typeof enabled !== 'boolean') errors.push({ path: 'enabled', code: 'type' });
  const audience = oneOf(raw.audience, AUDIENCES, 'audience', errors);
  let audiencePercent: number | null = null;
  if (audience === 'percent') {
    audiencePercent = integerIn(
      raw.audiencePercent,
      BOUNDS.audiencePercent,
      'audiencePercent',
      errors,
    );
  } else if (raw.audiencePercent !== null) {
    // Only a percentage rollout has a percentage: anything else would be stored and ignored.
    errors.push({ path: 'audiencePercent', code: 'type' });
  }
  const scope = oneOf(raw.scope, SCOPES, 'scope', errors);
  if (UNAVAILABLE_OPTIONS.scope.includes(scope))
    errors.push({ path: 'scope', code: 'unavailable' });
  const modelTier = oneOf(raw.modelTier, MODEL_TIERS, 'modelTier', errors);
  const users = oneOf(raw.users, USER_GROUPS, 'users', errors);
  const guestMessageLimit = integerIn(
    raw.guestMessageLimit,
    BOUNDS.guestMessageLimit,
    'guestMessageLimit',
    errors,
  );
  const customerMessageLimit = integerIn(
    raw.customerMessageLimit,
    BOUNDS.customerMessageLimit,
    'customerMessageLimit',
    errors,
  );
  const retention = oneOf(raw.retention, RETENTIONS, 'retention', errors);
  const replyLanguage = oneOf(raw.replyLanguage, REPLY_LANGUAGES, 'replyLanguage', errors);
  const daily = integerIn(
    raw.dailySpendCapUsdCents,
    BOUNDS.dailySpendCapUsdCents,
    'dailySpendCapUsdCents',
    errors,
  );
  const monthly = integerIn(
    raw.monthlySpendCapUsdCents,
    BOUNDS.monthlySpendCapUsdCents,
    'monthlySpendCapUsdCents',
    errors,
  );
  if (!errors.some((e) => e.path.endsWith('SpendCapUsdCents')) && daily > monthly) {
    errors.push({ path: 'dailySpendCapUsdCents', code: 'range' });
  }
  const supportHandoff = oneOf(raw.supportHandoff, SUPPORT_HANDOFFS, 'supportHandoff', errors);
  if (UNAVAILABLE_OPTIONS.supportHandoff.includes(supportHandoff)) {
    errors.push({ path: 'supportHandoff', code: 'unavailable' });
  }
  const welcome = parseWelcomeText(raw.welcomeText);
  if (!welcome.ok) errors.push(welcome.error);

  if (errors.length > 0) return err(errors);
  return ok({
    enabled: enabled as boolean,
    audience,
    audiencePercent,
    scope,
    modelTier,
    users,
    guestMessageLimit,
    customerMessageLimit,
    retention,
    replyLanguage,
    dailySpendCapUsdCents: daily,
    monthlySpendCapUsdCents: monthly,
    supportHandoff,
    welcomeText: welcome.ok ? welcome.value : null,
  });
}

export function sameSettings(a: AssistantSettings, b: AssistantSettings): boolean {
  return SETTING_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * A visitor's stable rollout bucket, 0 to 99 (FNV-1a over the Market and the visitor key). Not a
 * security control: it only spreads a percentage rollout evenly and keeps one visitor in or out.
 */
export function rolloutBucket(marketId: string, visitorKey: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(`${marketId}:${visitorKey}`)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

/**
 * Whether the rollout shows the assistant to this storefront visitor. `internal` reaches no
 * storefront visitor yet: internal testing goes through the admin panel until a preview route
 * exists. A percentage rollout needs a visitor key; without one the visitor is left out.
 */
export function inRollout(
  settings: AssistantSettings,
  marketId: string,
  visitorKey: string | null,
): boolean {
  if (!settings.enabled) return false;
  switch (settings.audience) {
    case 'all':
      return true;
    case 'internal':
      return false;
    case 'percent':
      return (
        visitorKey !== null &&
        settings.audiencePercent !== null &&
        rolloutBucket(marketId, visitorKey) < settings.audiencePercent
      );
  }
}
