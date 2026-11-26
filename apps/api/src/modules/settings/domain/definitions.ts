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

// `ai-description-writer-tier` (the writer's model tier) was a setting until AI Gateway G4d1: the
// writer's models are now the Market's list for the write task type (`ai-models-write`). Its
// stored rows stay (no setting is deleted, ADR-0026 decision 4); with no definition, every reader
// skips them and a review of an old change reverts as `gone`.

/**
 * Codes of settings that were retired. Their stored rows stay (ADR-0026 decision 4), so a new
 * definition must never reuse one: the old rows would quietly come back into force (checked by a
 * unit test against {@link SETTING_CODES}).
 */
export const RETIRED_SETTING_CODES: readonly string[] = ['ai-description-writer-tier'];

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
/**
 * The evaluation budget's month (AI Gateway G4c, design section 8): what evaluation runs and the
 * playground may spend, apart from the caps above. Never `none`, default 0 (no evaluation call
 * until a senior admin sets it).
 */
export const AI_CAP_EVALUATION_MONTH_CODE = 'ai-cap-evaluation-month';

/**
 * The buyer assistant's chat (`assistant.buyer-chat`, registered by `assistant`), the one
 * capability with caps of its own (G4d2). A string here, so settings imports no module; a contract
 * test checks it is a registered capability.
 */
export const AI_BUYER_CHAT_CAPABILITY = 'assistant.buyer-chat';
/**
 * The buyer chat's own day and month caps (G4d2; they replace the assistant settings' spend caps):
 * `none` or micro-dollars like the caps above. The defaults are the assistant's former defaults
 * (US$10 a day, US$200 a month), so a Market that never set them is not uncapped. The day cap is
 * never above the month cap when both are numbers (server check on the Limits tab).
 */
export const AI_CAP_BUYER_CHAT_DAY_CODE = 'ai-cap-buyer-chat-day';
export const AI_CAP_BUYER_CHAT_MONTH_CODE = 'ai-cap-buyer-chat-month';
export const AI_CAP_BUYER_CHAT_DAY_DEFAULT = '10000000';
export const AI_CAP_BUYER_CHAT_MONTH_DEFAULT = '200000000';

/** Every AI cap code, as the Limits tab shows and saves them. */
export const AI_CAP_CODES: readonly string[] = Object.freeze([
  AI_CAP_MARKET_DAY_CODE,
  AI_CAP_MARKET_MONTH_CODE,
  AI_CAP_CAPABILITY_DAY_CODE,
  AI_CAP_SELLER_DAY_CODE,
  AI_CAP_GUEST_DAY_CODE,
  AI_CAP_EVALUATION_MONTH_CODE,
  AI_CAP_BUYER_CHAT_DAY_CODE,
  AI_CAP_BUYER_CHAT_MONTH_CODE,
]);

/**
 * The Limits tab's check of the page as it would stand (G4d2): a capability's own day cap is never
 * above its month cap when both are numbers. `none` on either side passes.
 */
export function capPairIssues(
  values: ReadonlyMap<string, string>,
): readonly { readonly path: string; readonly code: string }[] {
  const day = capOf(values.get(AI_CAP_BUYER_CHAT_DAY_CODE) ?? AI_CAP_NONE);
  const month = capOf(values.get(AI_CAP_BUYER_CHAT_MONTH_CODE) ?? AI_CAP_NONE);
  if (day !== null && month !== null && day > month) {
    return [{ path: AI_CAP_BUYER_CHAT_DAY_CODE, code: 'range' }];
  }
  return [];
}

/**
 * The per-capability switches of the AI Gateway page (G4d3, design section 5): one Market setting
 * per registered capability, read by the gateway right after the emergency stop and before the
 * seller switch. `on` by default (nothing live changes: a new capability is still closed by its
 * module switch and the evaluation gate), `off` when a stored value is not allowed; a capability
 * without a switch, or a store that cannot be read, is off. Switching one off needs no two-step
 * code; switching one on does, and a revert of a review never switches one on. The capability ids
 * are strings here, so settings imports no module; a contract test checks them against the
 * registry. Codes use dashes: a setting code cannot hold a dot.
 */
export const AI_CAPABILITY_SWITCH_VALUES = ['off', 'on'] as const;
export const AI_CAPABILITY_SWITCHES: Readonly<Record<string, string>> = Object.freeze({
  'ai-capability-assistant-buyer-chat': AI_BUYER_CHAT_CAPABILITY,
  'ai-capability-catalog-description-writer-seller': 'catalog.description-writer.seller',
  'ai-capability-catalog-description-writer-admin': 'catalog.description-writer.admin',
});
/** Every capability switch code, as the AI Gateway page shows and saves them. */
export const AI_CAPABILITY_SWITCH_CODES: readonly string[] = Object.freeze(
  Object.keys(AI_CAPABILITY_SWITCHES),
);

/** Every AI Gateway setting code (the AI Gateway page). */
export const AI_GATEWAY_CODES: readonly string[] = Object.freeze([
  AI_GATEWAY_EMERGENCY_STOP_CODE,
  ...AI_CAP_CODES,
  ...AI_CAPABILITY_SWITCH_CODES,
]);

/** A cap's stored value in micro-dollars; null for `none` or anything else. */
export function capOf(value: string): number | null {
  return AI_CAP_VALUE.test(value) ? Number(value) : null;
}

/**
 * Whether changing an AI Gateway setting from `was` to `next` allows more AI (design section 8): a
 * cap raised or lifted, or the emergency stop switched off. Such a change needs the admin's fresh
 * two-step code and is never made by a revert; tightening never needs either. A capability switch
 * moved to `on` loosens too (G4d3). A value the definition does not allow is taken as the
 * tightest (cap 0, stop on, switch off), so leaving it loosens.
 */
export function loosensAi(code: string, was: string, next: string): boolean {
  if (code === AI_GATEWAY_EMERGENCY_STOP_CODE) return was !== 'off' && next === 'off';
  if (AI_CAPABILITY_SWITCH_CODES.includes(code)) return was !== 'on' && next === 'on';
  // The in-house model's settings (G6b): more calls or data to it, or a slower rollback.
  if (AI_IN_HOUSE_CODES.includes(code)) return loosensInHouse(code, was, next);
  if (!AI_CAP_CODES.includes(code)) return false;
  const before = was === AI_CAP_NONE ? Infinity : (capOf(was) ?? 0);
  const after = next === AI_CAP_NONE ? Infinity : (capOf(next) ?? 0);
  return after > before;
}

/** The AI task types a Market chooses models for (platform/ai `CAPABILITY_TASKS`, design section 6). */
export const AI_MODEL_TASKS = ['chat', 'extract', 'write', 'vision'] as const;
export type AiModelTask = (typeof AI_MODEL_TASKS)[number];

/** No model chosen: the list is empty, so the task type has no route and its AI is off (G4d1). */
export const AI_MODELS_NONE = 'none';
/** A model family of the route catalogue as a setting holds it: at most 20 characters (`none` is
 * never a family). */
const AI_FAMILY = '[a-z0-9][a-z0-9.-]{0,19}';
/** A priority list: 1 to 3 families, comma-separated, in the order to try (64 characters at most). */
const AI_MODEL_LIST_VALUE = new RegExp(`^${AI_FAMILY}(?:,${AI_FAMILY}){0,2}$`);
const AI_SAVER_VALUE = new RegExp(`^${AI_FAMILY}$`);

/** The priority list of one task type (the External models tab, design section 7). */
export const aiModelsCode = (task: AiModelTask): string => `ai-models-${task}`;
/** The saver model of one task type, put first from the saver threshold. */
export const aiSaverCode = (task: AiModelTask): string => `ai-saver-${task}`;
/** The share of the Market's month cap (50 to 99 %) from which a task's saver model goes first. */
export const AI_SAVER_PERCENT_CODE = 'ai-saver-percent';

export const AI_MODEL_LIST_CODES: readonly string[] = Object.freeze(
  AI_MODEL_TASKS.map(aiModelsCode),
);
export const AI_SAVER_CODES: readonly string[] = Object.freeze(AI_MODEL_TASKS.map(aiSaverCode));
/** Every AI model setting code, as the External models tab shows and saves them. */
export const AI_MODEL_CODES: readonly string[] = Object.freeze([
  ...AI_MODEL_LIST_CODES,
  ...AI_SAVER_CODES,
  AI_SAVER_PERCENT_CODE,
]);

/**
 * The in-house model's stages (Mondapac Intelligence tab, design section 8; AI Gateway G6b), the
 * values of platform/ai's `IN_HOUSE_STAGES` (a contract test checks they match; settings imports
 * no AI code here). Off by default and when a stored value is not allowed.
 */
export const AI_IN_HOUSE_STAGE_VALUES = ['off', 'shadow', 'percent', 'default'] as const;
export type AiInHouseStage = (typeof AI_IN_HOUSE_STAGE_VALUES)[number];
const AI_IN_HOUSE_FAMILY_VALUE = new RegExp(`^${AI_FAMILY}$`);

/** A task type's in-house stage. */
export const aiInHouseStageCode = (task: AiModelTask): string => `ai-in-house-stage-${task}`;
/** A task type's in-house model family (`none` or one family; "roll back to the previous version"
 * is a change of this value). */
export const aiInHouseModelCode = (task: AiModelTask): string => `ai-in-house-model-${task}`;
/** The share (0 to 100 %) of a task type's calls also sent to the in-house model in shadow. */
export const aiInHouseShadowCode = (task: AiModelTask): string => `ai-in-house-shadow-${task}`;
/** The share (0 to 99 %) of a task type's calls the in-house model answers in percent. */
export const aiInHouseRolloutCode = (task: AiModelTask): string => `ai-in-house-rollout-${task}`;
/**
 * The auto-rollback limits of the Market (design section 8, "Auto rollback"), for every task type
 * in percent or default: the error rate and the guard-rejection rate in tenths of a percent (1 to
 * 50, the server ceiling of 5 %, platform/ai `ROLLBACK_LIMIT_CEILING_PERMILLE`), and the fewest
 * in-house calls before they are judged (100 to 10,000, `ROLLBACK_MIN_SAMPLE_FLOOR` and `_TOP`).
 */
export const AI_IN_HOUSE_ROLLBACK_ERRORS_CODE = 'ai-in-house-rollback-errors';
export const AI_IN_HOUSE_ROLLBACK_GUARD_CODE = 'ai-in-house-rollback-guard';
export const AI_IN_HOUSE_ROLLBACK_SAMPLE_CODE = 'ai-in-house-rollback-sample';
export const AI_IN_HOUSE_ROLLBACK_LIMIT = { min: 1, max: 50 } as const;
export const AI_IN_HOUSE_ROLLBACK_SAMPLE = { min: 100, max: 10_000 } as const;

export const AI_IN_HOUSE_STAGE_CODES: readonly string[] = Object.freeze(
  AI_MODEL_TASKS.map(aiInHouseStageCode),
);
export const AI_IN_HOUSE_MODEL_CODES: readonly string[] = Object.freeze(
  AI_MODEL_TASKS.map(aiInHouseModelCode),
);
export const AI_IN_HOUSE_SHARE_CODES: readonly string[] = Object.freeze([
  ...AI_MODEL_TASKS.map(aiInHouseShadowCode),
  ...AI_MODEL_TASKS.map(aiInHouseRolloutCode),
]);
export const AI_IN_HOUSE_ROLLBACK_CODES: readonly string[] = Object.freeze([
  AI_IN_HOUSE_ROLLBACK_ERRORS_CODE,
  AI_IN_HOUSE_ROLLBACK_GUARD_CODE,
  AI_IN_HOUSE_ROLLBACK_SAMPLE_CODE,
]);
/** Every in-house model setting code, as the Mondapac Intelligence tab shows and saves them. */
export const AI_IN_HOUSE_CODES: readonly string[] = Object.freeze([
  ...AI_IN_HOUSE_STAGE_CODES,
  ...AI_IN_HOUSE_MODEL_CODES,
  ...AI_IN_HOUSE_SHARE_CODES,
  ...AI_IN_HOUSE_ROLLBACK_CODES,
]);

/**
 * Whether changing an in-house setting from `was` to `next` sends more calls or data to the
 * in-house model, or makes its rollback slower (design section 8, In-place confirmation): any
 * change of the stage or the model but to off or `none`, a share raised, a rollback limit or the
 * minimum sample raised. Such a change needs the admin's fresh two-step code and is never made by
 * a review revert; switching off, lowering a share and tightening a limit need neither. A stored
 * value the definition does not allow is taken as the tightest (stage off, no model, share 0,
 * limit 1, sample 100), so leaving it loosens.
 */
export function loosensInHouse(code: string, was: string, next: string): boolean {
  if (AI_IN_HOUSE_STAGE_CODES.includes(code)) return next !== 'off' && next !== was;
  if (AI_IN_HOUSE_MODEL_CODES.includes(code)) return next !== AI_MODELS_NONE && next !== was;
  const definition = findDefinition(code);
  if (definition?.integer === undefined || !AI_IN_HOUSE_CODES.includes(code)) return false;
  const tightest = definition.integer.min;
  const before = acceptedValue(definition, was);
  return Number(next) > (before === null ? tightest : Number(before));
}

/** The families of a stored list or saver value, in order; none for `none` or anything else. */
export function familiesOf(value: string): readonly string[] {
  if (value === AI_MODELS_NONE || !AI_MODEL_LIST_VALUE.test(value)) return [];
  return value.split(',');
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
    code: AI_CAP_EVALUATION_MONTH_CODE,
    label: 'AI cap: evaluation runs per month (US micro-dollars)',
    // No `none`: the evaluation budget is never uncapped (fail-closed, G4c).
    values: [],
    pattern: AI_CAP_VALUE,
    defaultValue: '0',
    safeValue: '0',
  },
  {
    code: AI_CAP_BUYER_CHAT_DAY_CODE,
    label: 'AI cap: buyer assistant chat per day (US micro-dollars)',
    values: [AI_CAP_NONE],
    pattern: AI_CAP_VALUE,
    defaultValue: AI_CAP_BUYER_CHAT_DAY_DEFAULT,
    // An invalid stored value is read as 0: nothing allowed (ADR-0019 R8).
    safeValue: '0',
  },
  {
    code: AI_CAP_BUYER_CHAT_MONTH_CODE,
    label: 'AI cap: buyer assistant chat per month (US micro-dollars)',
    values: [AI_CAP_NONE],
    pattern: AI_CAP_VALUE,
    defaultValue: AI_CAP_BUYER_CHAT_MONTH_DEFAULT,
    // An invalid stored value is read as 0: nothing allowed (ADR-0019 R8).
    safeValue: '0',
  },
  {
    code: 'ai-capability-assistant-buyer-chat',
    label: 'AI capability switch: buyer assistant chat',
    values: AI_CAPABILITY_SWITCH_VALUES,
    defaultValue: 'on',
    // An invalid stored value switches the capability off (ADR-0019 R8).
    safeValue: 'off',
  },
  {
    code: 'ai-capability-catalog-description-writer-seller',
    label: 'AI capability switch: description writer (sellers)',
    values: AI_CAPABILITY_SWITCH_VALUES,
    defaultValue: 'on',
    // An invalid stored value switches the capability off (ADR-0019 R8).
    safeValue: 'off',
  },
  {
    code: 'ai-capability-catalog-description-writer-admin',
    label: 'AI capability switch: description writer (admins)',
    values: AI_CAPABILITY_SWITCH_VALUES,
    defaultValue: 'on',
    // An invalid stored value switches the capability off (ADR-0019 R8).
    safeValue: 'off',
  },
  {
    code: 'ai-models-chat',
    label: 'AI models: chat priority list',
    values: [AI_MODELS_NONE],
    pattern: AI_MODEL_LIST_VALUE,
    defaultValue: AI_MODELS_NONE,
    // An invalid stored value is no list; the router still checks every route on each call.
    safeValue: AI_MODELS_NONE,
  },
  {
    code: 'ai-models-extract',
    label: 'AI models: extract priority list',
    values: [AI_MODELS_NONE],
    pattern: AI_MODEL_LIST_VALUE,
    defaultValue: AI_MODELS_NONE,
    // An invalid stored value is no list; the router still checks every route on each call.
    safeValue: AI_MODELS_NONE,
  },
  {
    code: 'ai-models-write',
    label: 'AI models: write priority list',
    values: [AI_MODELS_NONE],
    pattern: AI_MODEL_LIST_VALUE,
    defaultValue: AI_MODELS_NONE,
    // An invalid stored value is no list; the router still checks every route on each call.
    safeValue: AI_MODELS_NONE,
  },
  {
    code: 'ai-models-vision',
    label: 'AI models: vision priority list',
    values: [AI_MODELS_NONE],
    pattern: AI_MODEL_LIST_VALUE,
    defaultValue: AI_MODELS_NONE,
    // An invalid stored value is no list; the router still checks every route on each call.
    safeValue: AI_MODELS_NONE,
  },
  {
    code: 'ai-saver-chat',
    label: 'AI models: chat saver model',
    values: [AI_MODELS_NONE],
    pattern: AI_SAVER_VALUE,
    defaultValue: AI_MODELS_NONE,
    safeValue: AI_MODELS_NONE,
  },
  {
    code: 'ai-saver-extract',
    label: 'AI models: extract saver model',
    values: [AI_MODELS_NONE],
    pattern: AI_SAVER_VALUE,
    defaultValue: AI_MODELS_NONE,
    safeValue: AI_MODELS_NONE,
  },
  {
    code: 'ai-saver-write',
    label: 'AI models: write saver model',
    values: [AI_MODELS_NONE],
    pattern: AI_SAVER_VALUE,
    defaultValue: AI_MODELS_NONE,
    safeValue: AI_MODELS_NONE,
  },
  {
    code: 'ai-saver-vision',
    label: 'AI models: vision saver model',
    values: [AI_MODELS_NONE],
    pattern: AI_SAVER_VALUE,
    defaultValue: AI_MODELS_NONE,
    safeValue: AI_MODELS_NONE,
  },
  {
    code: AI_SAVER_PERCENT_CODE,
    label: 'AI models: saver threshold (% of the month cap)',
    values: [],
    integer: { min: 50, max: 99 },
    defaultValue: '80',
    // The cheaper model from half the month cap on: the cheap side.
    safeValue: '50',
  },
  {
    code: 'ai-in-house-stage-chat',
    label: 'Mondapac Intelligence: chat stage',
    values: AI_IN_HOUSE_STAGE_VALUES,
    defaultValue: 'off',
    safeValue: 'off',
  },
  {
    code: 'ai-in-house-stage-extract',
    label: 'Mondapac Intelligence: extract stage',
    values: AI_IN_HOUSE_STAGE_VALUES,
    defaultValue: 'off',
    safeValue: 'off',
  },
  {
    code: 'ai-in-house-stage-write',
    label: 'Mondapac Intelligence: write stage',
    values: AI_IN_HOUSE_STAGE_VALUES,
    defaultValue: 'off',
    safeValue: 'off',
  },
  {
    code: 'ai-in-house-stage-vision',
    label: 'Mondapac Intelligence: vision stage',
    values: AI_IN_HOUSE_STAGE_VALUES,
    defaultValue: 'off',
    safeValue: 'off',
  },
  {
    code: 'ai-in-house-model-chat',
    label: 'Mondapac Intelligence: chat model',
    values: [AI_MODELS_NONE],
    pattern: AI_IN_HOUSE_FAMILY_VALUE,
    defaultValue: AI_MODELS_NONE,
    safeValue: AI_MODELS_NONE,
  },
  {
    code: 'ai-in-house-model-extract',
    label: 'Mondapac Intelligence: extract model',
    values: [AI_MODELS_NONE],
    pattern: AI_IN_HOUSE_FAMILY_VALUE,
    defaultValue: AI_MODELS_NONE,
    safeValue: AI_MODELS_NONE,
  },
  {
    code: 'ai-in-house-model-write',
    label: 'Mondapac Intelligence: write model',
    values: [AI_MODELS_NONE],
    pattern: AI_IN_HOUSE_FAMILY_VALUE,
    defaultValue: AI_MODELS_NONE,
    safeValue: AI_MODELS_NONE,
  },
  {
    code: 'ai-in-house-model-vision',
    label: 'Mondapac Intelligence: vision model',
    values: [AI_MODELS_NONE],
    pattern: AI_IN_HOUSE_FAMILY_VALUE,
    defaultValue: AI_MODELS_NONE,
    safeValue: AI_MODELS_NONE,
  },
  {
    code: 'ai-in-house-shadow-chat',
    label: 'Mondapac Intelligence: chat shadow share (%)',
    values: [],
    integer: { min: 0, max: 100 },
    defaultValue: '0',
    safeValue: '0',
  },
  {
    code: 'ai-in-house-shadow-extract',
    label: 'Mondapac Intelligence: extract shadow share (%)',
    values: [],
    integer: { min: 0, max: 100 },
    defaultValue: '0',
    safeValue: '0',
  },
  {
    code: 'ai-in-house-shadow-write',
    label: 'Mondapac Intelligence: write shadow share (%)',
    values: [],
    integer: { min: 0, max: 100 },
    defaultValue: '0',
    safeValue: '0',
  },
  {
    code: 'ai-in-house-shadow-vision',
    label: 'Mondapac Intelligence: vision shadow share (%)',
    values: [],
    integer: { min: 0, max: 100 },
    defaultValue: '0',
    safeValue: '0',
  },
  {
    code: 'ai-in-house-rollout-chat',
    label: 'Mondapac Intelligence: chat percent share (%)',
    values: [],
    integer: { min: 0, max: 99 },
    defaultValue: '0',
    safeValue: '0',
  },
  {
    code: 'ai-in-house-rollout-extract',
    label: 'Mondapac Intelligence: extract percent share (%)',
    values: [],
    integer: { min: 0, max: 99 },
    defaultValue: '0',
    safeValue: '0',
  },
  {
    code: 'ai-in-house-rollout-write',
    label: 'Mondapac Intelligence: write percent share (%)',
    values: [],
    integer: { min: 0, max: 99 },
    defaultValue: '0',
    safeValue: '0',
  },
  {
    code: 'ai-in-house-rollout-vision',
    label: 'Mondapac Intelligence: vision percent share (%)',
    values: [],
    integer: { min: 0, max: 99 },
    defaultValue: '0',
    safeValue: '0',
  },
  {
    code: AI_IN_HOUSE_ROLLBACK_ERRORS_CODE,
    label: 'Mondapac Intelligence: rollback error rate (tenths of a %)',
    values: [],
    integer: AI_IN_HOUSE_ROLLBACK_LIMIT,
    defaultValue: '20',
    // The tightest limit: the gateway returns to the external models soonest.
    safeValue: '1',
  },
  {
    code: AI_IN_HOUSE_ROLLBACK_GUARD_CODE,
    label: 'Mondapac Intelligence: rollback guard-rejection rate (tenths of a %)',
    values: [],
    integer: AI_IN_HOUSE_ROLLBACK_LIMIT,
    defaultValue: '10',
    safeValue: '1',
  },
  {
    code: AI_IN_HOUSE_ROLLBACK_SAMPLE_CODE,
    label: 'Mondapac Intelligence: rollback minimum sample (calls)',
    values: [],
    integer: AI_IN_HOUSE_ROLLBACK_SAMPLE,
    defaultValue: '200',
    // The smallest sample: the rates are judged soonest.
    safeValue: '100',
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
