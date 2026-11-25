import type { CallContext } from '@mondapac/shared-kernel';
import type { AiModelTierSetting, CartMode } from '../domain/definitions';

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
   * The limits of the Offer review queue backlog alert, for the system actor of a worker job. Null
   * when the store cannot be read or a refusal or throw happens: the alert then acts on no guess.
   */
  offerQueueBacklogLimits(context: CallContext): Promise<OfferQueueBacklogLimits | null>;
}

export const SETTINGS_FACADE = Symbol('SETTINGS_FACADE');
