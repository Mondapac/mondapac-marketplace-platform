import type { CallContext, Money, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { AiModelTierSetting, CartMode } from '../domain/definitions';
import type { OfferReviewPolicySettings } from '../application/use-cases/read-offer-review-policy.use-case';

export type { OfferReviewPolicySettings };

/** The two limits of the Offer review queue backlog alert (whole numbers, both at least 1). */
export interface OfferQueueBacklogLimits {
  /** Offers waiting in the queue above which the alert is raised. */
  readonly count: number;
  /** Business hours the oldest waiting Offer may wait before the alert is raised. */
  readonly hours: number;
}

/**
 * What other modules read from the settings store (ADR-0026 decision 2). Each method carries the
 * caller's `CallContext` unchanged and answers for its Market alone.
 */
export interface SettingsFacade {
  /**
   * Whether the AI description writer is on in the Market, and its model tier (AIS-03). Never an
   * error: a store that cannot be read answers off (ADR-0019 R8).
   */
  aiDescriptionWriter(
    context: CallContext,
  ): Promise<{ readonly enabled: boolean; readonly tier: AiModelTierSetting }>;

  /**
   * The Market's Cart mode (`multi-store` or `single-store`), for any caller (guest, customer,
   * panel user). Never an error: a store that cannot be read, a refusal or a throw answers
   * `multi-store`, today's behaviour (ADR-0026 decision 5).
   */
  cartMode(context: CallContext): Promise<CartMode>;

  /**
   * The Market's monthly revenue target (null: none set), for a caller holding
   * `settings.monthly-revenue-target.view` (else `access.denied`). A store that cannot be read is
   * `access.unavailable`, never "no target".
   */
  monthlyRevenueTarget(context: CallContext): Promise<Result<Money | null, AccessDenied>>;

  /**
   * The Market's Offer review policy (ADR-0051), for any caller. Never an error: a refusal or a
   * throw answers the safe policy (every Offer waits for an admin; ADR-0026 decision 5).
   */
  offerReviewPolicy(context: CallContext): Promise<OfferReviewPolicySettings>;

  /**
   * The limits of the Offer review queue backlog alert, for the system actor of a worker job. Null
   * when the store cannot be read or a refusal or throw happens: the alert then acts on no guess.
   */
  offerQueueBacklogLimits(context: CallContext): Promise<OfferQueueBacklogLimits | null>;
}

export const SETTINGS_FACADE = Symbol('SETTINGS_FACADE');
