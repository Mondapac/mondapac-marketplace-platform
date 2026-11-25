import type { Money } from '@mondapac/shared-kernel';

// The admin-editable Market settings (ADR-0026), declared in code: code, allowed values, the
// value in force while no admin has changed it, and the safe value used when the store cannot be
// read. Adding a setting is adding a definition here (and its translation keys in the panels).

export const LIST_PAGING_CODE = 'list-paging';

/** `pages`: page numbers with the total. `prev-next`: Previous and Next, no jump to a page. */
export const LIST_PAGING_VALUES = ['pages', 'prev-next'] as const;
export type ListPaging = (typeof LIST_PAGING_VALUES)[number];

export const CART_MODE_CODE = 'cart-mode';

/**
 * How a buyer's cart treats several stores. `multi-store`: one cart may hold lines from several
 * stores (one order per store). `single-store`: a cart holds one store only. This setting only
 * stores the choice; the cart and ordering read it in their own packages.
 */
export const CART_MODE_VALUES = ['multi-store', 'single-store'] as const;
export type CartMode = (typeof CART_MODE_VALUES)[number];

export const AI_DESCRIPTION_WRITER_CODE = 'ai-description-writer';

/**
 * Whether the AI description writer (AIS-03, admin and seller) may be used in the Market. Off by
 * default and when the store cannot be read (ADR-0019 R8, ADR-0026 decision 5). Turned on only
 * after the real-model evaluation of its prompt version is recorded as passed (decision 9).
 */
export const AI_DESCRIPTION_WRITER_VALUES = ['off', 'on'] as const;
export type AiDescriptionWriter = (typeof AI_DESCRIPTION_WRITER_VALUES)[number];

export const AI_DESCRIPTION_WRITER_TIER_CODE = 'ai-description-writer-tier';

/**
 * Which of the Market's model tiers the writer uses. The model id of each tier, the provider and
 * the key stay server configuration (ADR-0026 decision 9, R7); only the tier is a setting.
 */
export const AI_MODEL_TIER_VALUES = ['fast', 'balanced'] as const;
export type AiModelTierSetting = (typeof AI_MODEL_TIER_VALUES)[number];

export const MONTHLY_REVENUE_TARGET_CODE = 'monthly-revenue-target';

/**
 * The Market's monthly revenue target (dashboards v2 phase 2): the GMV with tax the marketplace
 * aims for in each calendar month of the Market's zone, the basis of the admin KPI GMV. `none`
 * (the default and the safe value) or `<ISO 4217 code>:<minor units>`, for example
 * `AUD:24000000`; the currency is the Market's when it is set, never assumed. It stays in force
 * for every month until it is changed; the history keeps the earlier targets.
 */
export const MONTHLY_REVENUE_TARGET_NONE = 'none';
/** At most 15 digits of minor units (inside a BIGINT and below 2^53). */
const MONEY_VALUE = /^([A-Z]{3}):([1-9][0-9]{0,14})$/;

/** The target a stored value names; null for `none` or anything else. */
export function targetOf(value: string): Money | null {
  const match = MONEY_VALUE.exec(value);
  if (match === null) return null;
  return Object.freeze({ amount: BigInt(match[2]!), currency: match[1]! });
}

/** The stored value of a target (null: `none`). */
export function targetValue(target: Money | null): string {
  return target === null
    ? MONTHLY_REVENUE_TARGET_NONE
    : `${target.currency}:${target.amount.toString()}`;
}

export const OFFER_REVIEW_MODE_CODE = 'offer-review-mode';

/**
 * How a new Offer on a platform product is approved (risk-based Offer approval, catalog brief
 * CAT-36). `all`: every first publication waits for an admin, as before. `risk-based`: an Offer
 * that passes the automatic checks goes live at once and only the risky ones wait (R0 to R7).
 * `off`: no Offer waits for an admin. This PR only stores the choice; catalog reads it later.
 */
export const OFFER_REVIEW_MODE_VALUES = ['all', 'risk-based', 'off'] as const;
export type OfferReviewMode = (typeof OFFER_REVIEW_MODE_VALUES)[number];

/** How many of a new seller's first Offers wait for an admin (R1 probation). */
export const OFFER_REVIEW_PROBATION_CODE = 'offer-review-probation-offers';
/**
 * How many live Offers from different businesses (ABNs) a Variant needs before their median
 * regular price is the reference; until then an Offer's first price is taken as it is and the
 * Offer is always checked after it goes live (R4).
 */
export const OFFER_REVIEW_REFERENCE_SELLERS_CODE = 'offer-review-reference-sellers';
/** How far, in percent above or below the reference, a first price may be before it waits (R4). */
export const OFFER_REVIEW_PRICE_BAND_CODE = 'offer-review-price-band';
/** The percent of Offers that went live automatically that are checked afterwards. */
export const OFFER_REVIEW_SAMPLING_CODE = 'offer-review-sampling';
/** Whether an Offer with a certification badge always waits for an admin (R2). */
export const OFFER_REVIEW_BADGES_CODE = 'offer-review-certificate-badges';
export const OFFER_REVIEW_BADGES_VALUES = ['review', 'automatic'] as const;
export type OfferReviewBadges = (typeof OFFER_REVIEW_BADGES_VALUES)[number];

/**
 * How many Offers waiting in the Offer review queue raise the backlog alert (risk-based Offer
 * approval, slice 8). One alert per crossing of the limit.
 */
export const OFFER_REVIEW_BACKLOG_COUNT_CODE = 'offer-review-backlog-count';
/**
 * How many business hours (Monday to Friday, in the Market's time zone) the oldest Offer may wait
 * in the review queue before the backlog alert is raised.
 */
export const OFFER_REVIEW_BACKLOG_HOURS_CODE = 'offer-review-backlog-hours';
/**
 * The Offer review emergency stop (R0, design 9.5 b): while `on`, every new Offer of the Market
 * waits for an admin, even from a Trusted seller; live Offers stay live. Changed only through its
 * own protected permission with a reason, never with the page's other settings.
 */
export const OFFER_REVIEW_EMERGENCY_STOP_CODE = 'offer-review-emergency-stop';
export const OFFER_REVIEW_EMERGENCY_STOP_VALUES = ['off', 'on'] as const;

/** Every code of the Offer review policy, as one page shows and saves them. */
export const OFFER_REVIEW_CODES: readonly string[] = Object.freeze([
  OFFER_REVIEW_MODE_CODE,
  OFFER_REVIEW_PROBATION_CODE,
  OFFER_REVIEW_REFERENCE_SELLERS_CODE,
  OFFER_REVIEW_PRICE_BAND_CODE,
  OFFER_REVIEW_SAMPLING_CODE,
  OFFER_REVIEW_BADGES_CODE,
  OFFER_REVIEW_BACKLOG_COUNT_CODE,
  OFFER_REVIEW_BACKLOG_HOURS_CODE,
]);

/**
 * The Market's AI emergency stop (AI Gateway page, docs/design/domain/platform-ai.md section 8):
 * while `on`, every AI capability of the Market is off. Switching it on never needs the admin's
 * two-step code; switching it off (AI on again) does. A store that cannot be read is AI off.
 */
export const AI_GATEWAY_EMERGENCY_STOP_CODE = 'ai-gateway-emergency-stop';
export const AI_GATEWAY_EMERGENCY_STOP_VALUES = ['off', 'on'] as const;

/** No cap: the counter is counted and not enforced. */
export const AI_CAP_NONE = 'none';
/**
 * An AI budget cap in US micro-dollars (1 = US$0.000001): a whole number up to 10^12 (US$1
 * million), the bound the Market configuration's `aiBudget` had before G4. 0 allows nothing.
 */
const AI_CAP_VALUE = /^(0|[1-9][0-9]{0,11}|1000000000000)$/;

/** The AI Gateway's caps (the Limits tab, design section 7): the Market's day and month, each
 * capability's day, each seller's day and the guest pool's day. */
export const AI_CAP_MARKET_DAY_CODE = 'ai-cap-market-day';
export const AI_CAP_MARKET_MONTH_CODE = 'ai-cap-market-month';
export const AI_CAP_CAPABILITY_DAY_CODE = 'ai-cap-capability-day';
export const AI_CAP_SELLER_DAY_CODE = 'ai-cap-seller-day';
export const AI_CAP_GUEST_DAY_CODE = 'ai-cap-guest-day';

/** Every AI cap code, as the Limits tab shows and saves them. */
export const AI_CAP_CODES: readonly string[] = Object.freeze([
  AI_CAP_MARKET_DAY_CODE,
  AI_CAP_MARKET_MONTH_CODE,
  AI_CAP_CAPABILITY_DAY_CODE,
  AI_CAP_SELLER_DAY_CODE,
  AI_CAP_GUEST_DAY_CODE,
]);

/** Every AI Gateway setting code (the AI Gateway page). */
export const AI_GATEWAY_CODES: readonly string[] = Object.freeze([
  AI_GATEWAY_EMERGENCY_STOP_CODE,
  ...AI_CAP_CODES,
]);

/** A cap's stored value in micro-dollars; null for `none` or anything else. */
export function capOf(value: string): number | null {
  return AI_CAP_VALUE.test(value) ? Number(value) : null;
}

/**
 * Whether changing an AI Gateway setting from `was` to `next` allows more AI (design section 8): a
 * cap raised or lifted, or the emergency stop switched off. Such a change needs the admin's fresh
 * two-step code and is never made by a revert; tightening never needs either. A value the
 * definition does not allow is taken as the tightest (cap 0, stop on), so leaving it loosens.
 */
export function loosensAi(code: string, was: string, next: string): boolean {
  if (code === AI_GATEWAY_EMERGENCY_STOP_CODE) return was !== 'off' && next === 'off';
  if (!AI_CAP_CODES.includes(code)) return false;
  const before = was === AI_CAP_NONE ? Infinity : (capOf(was) ?? 0);
  const after = next === AI_CAP_NONE ? Infinity : (capOf(next) ?? 0);
  return after > before;
}

/** A whole number setting: its value is stored as a decimal text such as "10". */
export interface IntegerBounds {
  readonly min: number;
  readonly max: number;
}

export interface SettingDefinition {
  readonly code: string;
  /** The English name admins know it by, as the System requests queue labels its changes. */
  readonly label: string;
  /** The allowed values of a choice; empty for a whole number setting. */
  readonly values: readonly string[];
  /** A setting whose values are not a list (an amount) accepts the values this matches too. */
  readonly pattern?: RegExp;
  /** Set for a whole number setting: the value is a decimal text within these bounds. */
  readonly integer?: IntegerBounds;
  /** In force while the Market has no row. */
  readonly defaultValue: string;
  /** Used when the store cannot be read: restrictive and cheap, never a Market choice. */
  readonly safeValue: string;
}

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = Object.freeze([
  {
    code: LIST_PAGING_CODE,
    label: 'List paging',
    values: LIST_PAGING_VALUES,
    defaultValue: 'pages',
    safeValue: 'prev-next',
  },
  {
    code: CART_MODE_CODE,
    label: 'Cart mode',
    values: CART_MODE_VALUES,
    defaultValue: 'multi-store',
    // An unreadable store keeps today's behaviour; the cart's own read decides what to enforce.
    safeValue: 'multi-store',
  },
  {
    code: AI_DESCRIPTION_WRITER_CODE,
    label: 'AI description writer',
    values: AI_DESCRIPTION_WRITER_VALUES,
    defaultValue: 'off',
    safeValue: 'off',
  },
  {
    code: AI_DESCRIPTION_WRITER_TIER_CODE,
    label: 'AI description writer tier',
    values: AI_MODEL_TIER_VALUES,
    defaultValue: 'fast',
    // The cheaper tier.
    safeValue: 'fast',
  },
  {
    code: OFFER_REVIEW_EMERGENCY_STOP_CODE,
    label: 'Offer review emergency stop',
    values: OFFER_REVIEW_EMERGENCY_STOP_VALUES,
    defaultValue: 'off',
    // A failed read of the policy already answers mode `all` (every Offer waits), so the safe
    // value stays `off`: an unreadable row must not raise a stop banner nobody switched on.
    safeValue: 'off',
  },
  {
    code: OFFER_REVIEW_MODE_CODE,
    label: 'Offer review mode',
    values: OFFER_REVIEW_MODE_VALUES,
    defaultValue: 'risk-based',
    // Every Offer waits for an admin, as before the risk rules.
    safeValue: 'all',
  },
  {
    code: OFFER_REVIEW_PROBATION_CODE,
    label: 'New seller offers reviewed',
    values: [],
    integer: { min: 0, max: 100 },
    defaultValue: '10',
    safeValue: '100',
  },
  {
    code: OFFER_REVIEW_REFERENCE_SELLERS_CODE,
    label: 'Sellers needed for a reference price',
    values: [],
    integer: { min: 2, max: 20 },
    defaultValue: '3',
    // More Offers are checked after they go live.
    safeValue: '20',
  },
  {
    code: OFFER_REVIEW_PRICE_BAND_CODE,
    label: 'Price band around the reference (%)',
    values: [],
    integer: { min: 5, max: 200 },
    defaultValue: '50',
    // The narrowest band: more first prices wait.
    safeValue: '5',
  },
  {
    code: OFFER_REVIEW_SAMPLING_CODE,
    label: 'Offers checked after going live (%)',
    values: [],
    integer: { min: 0, max: 100 },
    defaultValue: '5',
    safeValue: '100',
  },
  {
    code: OFFER_REVIEW_BADGES_CODE,
    label: 'Offers with a certification badge',
    values: OFFER_REVIEW_BADGES_VALUES,
    defaultValue: 'review',
    safeValue: 'review',
  },
  {
    code: OFFER_REVIEW_BACKLOG_COUNT_CODE,
    label: 'Offer queue size that raises an alert',
    values: [],
    integer: { min: 1, max: 10000 },
    defaultValue: '50',
    // Not used for the alert: its strict read answers nothing for an unreadable store.
    safeValue: '50',
  },
  {
    code: OFFER_REVIEW_BACKLOG_HOURS_CODE,
    label: 'Business hours before an Offer waiting raises an alert',
    values: [],
    integer: { min: 1, max: 720 },
    defaultValue: '24',
    safeValue: '24',
  },
  {
    code: AI_GATEWAY_EMERGENCY_STOP_CODE,
    label: 'AI emergency stop',
    values: AI_GATEWAY_EMERGENCY_STOP_VALUES,
    defaultValue: 'off',
    // An invalid stored value stops AI (R8); an unreadable store is off at the gateway anyway.
    safeValue: 'on',
  },
  {
    code: AI_CAP_MARKET_DAY_CODE,
    label: 'AI cap: Market per day (US micro-dollars)',
    values: [AI_CAP_NONE],
    pattern: AI_CAP_VALUE,
    defaultValue: AI_CAP_NONE,
    // An invalid stored value is read as 0: nothing allowed (ADR-0019 R8).
    safeValue: '0',
  },
  {
    code: AI_CAP_MARKET_MONTH_CODE,
    label: 'AI cap: Market per month (US micro-dollars)',
    values: [AI_CAP_NONE],
    pattern: AI_CAP_VALUE,
    defaultValue: AI_CAP_NONE,
    // An invalid stored value is read as 0: nothing allowed (ADR-0019 R8).
    safeValue: '0',
  },
  {
    code: AI_CAP_CAPABILITY_DAY_CODE,
    label: 'AI cap: each capability per day (US micro-dollars)',
    values: [AI_CAP_NONE],
    pattern: AI_CAP_VALUE,
    defaultValue: AI_CAP_NONE,
    // An invalid stored value is read as 0: nothing allowed (ADR-0019 R8).
    safeValue: '0',
  },
  {
    code: AI_CAP_SELLER_DAY_CODE,
    label: 'AI cap: each seller per day (US micro-dollars)',
    values: [AI_CAP_NONE],
    pattern: AI_CAP_VALUE,
    defaultValue: AI_CAP_NONE,
    // An invalid stored value is read as 0: nothing allowed (ADR-0019 R8).
    safeValue: '0',
  },
  {
    code: AI_CAP_GUEST_DAY_CODE,
    label: 'AI cap: guest share per day (US micro-dollars)',
    values: [AI_CAP_NONE],
    pattern: AI_CAP_VALUE,
    defaultValue: AI_CAP_NONE,
    // An invalid stored value is read as 0: nothing allowed (ADR-0019 R8).
    safeValue: '0',
  },
  {
    code: MONTHLY_REVENUE_TARGET_CODE,
    label: 'Monthly revenue target',
    values: [MONTHLY_REVENUE_TARGET_NONE],
    pattern: MONEY_VALUE,
    defaultValue: MONTHLY_REVENUE_TARGET_NONE,
    // An unreadable store is never read as a target; the dashboard section answers `error`.
    safeValue: MONTHLY_REVENUE_TARGET_NONE,
  },
]);

export const SETTING_CODES: readonly string[] = SETTING_DEFINITIONS.map((d) => d.code);

export function findDefinition(code: unknown): SettingDefinition | null {
  return SETTING_DEFINITIONS.find((definition) => definition.code === code) ?? null;
}

const DECIMAL = /^(0|[1-9][0-9]{0,8})$/;

/**
 * The value as the store keeps it when the definition allows it, or null: one of a choice's values
 * or a text its pattern matches (an amount), or a whole number within the bounds written as plain decimal text (a JSON number is accepted and
 * written as text; "07", "1e2" and "10.0" are not).
 */
export function acceptedValue(definition: SettingDefinition, value: unknown): string | null {
  if (definition.integer === undefined) {
    if (typeof value !== 'string') return null;
    return definition.values.includes(value) || (definition.pattern?.test(value) ?? false)
      ? value
      : null;
  }
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !DECIMAL.test(text)) return null;
  const number = Number(text);
  return number >= definition.integer.min && number <= definition.integer.max ? text : null;
}
