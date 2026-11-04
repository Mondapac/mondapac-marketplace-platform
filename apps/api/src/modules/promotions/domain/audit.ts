import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import { PROMOTIONS_STATUSES } from './market-status';
import { CREATABLE_TYPES, FUNDINGS, PROMOTION_STATUSES, REWARD_KINDS } from './promotion';

// The audited actions of promotions, registered at boot with
// `registerAuditActions('promotions', PROMOTIONS_AUDIT_ACTIONS)`. A promotion's name and code are
// free text chosen by its owner and have no field here; money is always minor units with its
// currency. Every create, edit, pause, resume, budget change and review decision is recorded with
// the actor, the time and what changed.

/** `PENDING_APPROVAL` as an audit enum code: `pending-approval` (audit enums are lower-case). */
export type AuditCode<S extends string> = S extends `${infer A}_${infer B}`
  ? `${Lowercase<A>}-${AuditCode<B>}`
  : Lowercase<S>;
export const auditCode = <S extends string>(value: S): AuditCode<S> =>
  value.toLowerCase().replaceAll('_', '-') as AuditCode<S>;
const codesOf = <const L extends readonly string[]>(
  values: L,
): { [K in keyof L]: AuditCode<L[K] & string> } => values.map(auditCode) as never;

/** The audit target type of the Market switch. */
export const PROMOTIONS_SETTINGS_TARGET = 'promotions.market-settings';
export const PROMOTION_TARGET = 'promotions.promotion';
export const PROMOTION_REVIEW_TARGET = 'promotions.promotion-review';
export const FIRST_ORDER_SETTINGS_TARGET = 'promotions.first-order-settings';
export const SHIPPING_THRESHOLD_TARGET = 'promotions.free-shipping-threshold';

/** An admin moved the Market's promotions to another state. */
export const PromotionsStatusChanged = defineAuditAction({
  action: 'promotions.market-status.changed',
  targetType: PROMOTIONS_SETTINGS_TARGET,
  targetId: auditField.enumOf(['promotions-settings'] as const),
  actors: ['authenticated'],
  before: { status: auditField.enumOf(PROMOTIONS_STATUSES) },
  after: { status: auditField.enumOf(PROMOTIONS_STATUSES) },
});

/** What an audit row says about a promotion: its terms, never its name or code. */
const terms = {
  type: auditField.enumOf(codesOf(CREATABLE_TYPES)),
  status: auditField.enumOf(codesOf(PROMOTION_STATUSES)),
  funding: auditField.enumOf(codesOf(FUNDINGS)),
  platformSplitBps: auditField.optional(auditField.integer()),
  ownerSellerId: auditField.optional(auditField.id()),
  combinable: auditField.boolean(),
  hasCode: auditField.boolean(),
  startsAt: auditField.instant(),
  endsAt: auditField.optional(auditField.instant()),
  testMode: auditField.boolean(),
  specialCampaign: auditField.boolean(),
  rewardKind: auditField.enumOf(codesOf(REWARD_KINDS)),
  rewardBps: auditField.optional(auditField.integer()),
  rewardAmount: auditField.optional(auditField.money()),
  budget: auditField.optional(auditField.money()),
};

const stepUp = {
  stepUpSessionId: auditField.optional(auditField.id()),
  stepUpVerifiedAt: auditField.optional(auditField.instant()),
};

/** A promotion was created by its owner (a seller, or an admin for the platform). */
export const PromotionCreated = defineAuditAction({
  action: 'promotions.promotion.created',
  targetType: PROMOTION_TARGET,
  actors: ['authenticated'],
  after: { ...terms, ...stepUp },
});

/** A promotion's terms were edited. */
export const PromotionEdited = defineAuditAction({
  action: 'promotions.promotion.edited',
  targetType: PROMOTION_TARGET,
  actors: ['authenticated'],
  before: terms,
  after: { ...terms, ...stepUp },
});

/** A live promotion was paused, by its seller or by an admin. */
export const PromotionPaused = defineAuditAction({
  action: 'promotions.promotion.paused',
  targetType: PROMOTION_TARGET,
  actors: ['authenticated'],
  before: { status: auditField.enumOf(codesOf(PROMOTION_STATUSES)) },
  after: {
    status: auditField.enumOf(codesOf(PROMOTION_STATUSES)),
    pausedBy: auditField.enumOf(['admin', 'seller'] as const),
  },
});

/** A paused promotion went live again. */
export const PromotionResumed = defineAuditAction({
  action: 'promotions.promotion.resumed',
  targetType: PROMOTION_TARGET,
  actors: ['authenticated'],
  before: { status: auditField.enumOf(codesOf(PROMOTION_STATUSES)) },
  after: { status: auditField.enumOf(codesOf(PROMOTION_STATUSES)) },
});

/** An admin changed the total budget of a platform promotion. */
export const PromotionBudgetChanged = defineAuditAction({
  action: 'promotions.promotion.budget-changed',
  targetType: PROMOTION_TARGET,
  actors: ['authenticated'],
  before: { budget: auditField.optional(auditField.money()) },
  after: { budget: auditField.optional(auditField.money()), ...stepUp },
});

/** An admin generated a batch of single-use codes; the codes themselves are never recorded. */
export const BatchCodesGenerated = defineAuditAction({
  action: 'promotions.batch-codes.generated',
  targetType: PROMOTION_TARGET,
  actors: ['authenticated'],
  after: { batchId: auditField.id(), count: auditField.integer(), ...stepUp },
});

/** A seller opted in to, or withdrew from, a co-funded campaign. */
export const CoFundingOptInChanged = defineAuditAction({
  action: 'promotions.co-funding.changed',
  targetType: PROMOTION_TARGET,
  actors: ['authenticated'],
  before: { optedIn: auditField.boolean() },
  after: { optedIn: auditField.boolean(), sellerId: auditField.id() },
});

/** An admin decided an entry of the seller-promotion review queue. */
export const PromotionReviewDecided = defineAuditAction({
  action: 'promotions.review.decided',
  targetType: PROMOTION_REVIEW_TARGET,
  actors: ['authenticated'],
  before: { promotionStatus: auditField.enumOf(codesOf(PROMOTION_STATUSES)) },
  after: {
    decision: auditField.enumOf(['approved', 'rejected'] as const),
    promotionStatus: auditField.enumOf(codesOf(PROMOTION_STATUSES)),
    promotionId: auditField.id(),
  },
});

const firstOrder = {
  enabled: auditField.boolean(),
  kind: auditField.enumOf(codesOf(REWARD_KINDS)),
  percentBps: auditField.optional(auditField.integer()),
  amount: auditField.optional(auditField.money()),
  cap: auditField.optional(auditField.money()),
  minSpend: auditField.optional(auditField.money()),
  monthlyBudget: auditField.optional(auditField.money()),
};

/** An admin changed the first-order discount of the Market. */
export const FirstOrderSettingsChanged = defineAuditAction({
  action: 'promotions.first-order-settings.changed',
  targetType: FIRST_ORDER_SETTINGS_TARGET,
  targetId: auditField.enumOf(['first-order-settings'] as const),
  actors: ['authenticated'],
  before: firstOrder,
  after: { ...firstOrder, ...stepUp },
});

/** An admin set, changed or cleared the free-shipping threshold of a delivery zone. */
export const ShippingThresholdChanged = defineAuditAction({
  action: 'promotions.free-shipping-threshold.changed',
  targetType: SHIPPING_THRESHOLD_TARGET,
  actors: ['authenticated'],
  before: { threshold: auditField.optional(auditField.money()) },
  after: { threshold: auditField.optional(auditField.money()), ...stepUp },
});

export const PROMOTIONS_AUDIT_ACTIONS = [
  PromotionsStatusChanged,
  PromotionCreated,
  PromotionEdited,
  PromotionPaused,
  PromotionResumed,
  PromotionBudgetChanged,
  BatchCodesGenerated,
  CoFundingOptInChanged,
  PromotionReviewDecided,
  FirstOrderSettingsChanged,
  ShippingThresholdChanged,
] as const;
