import type { MarketContext } from '@mondapac/shared-kernel';

/**
 * The admin actions on a customer's personal data that are counted per admin (security review of
 * #969, L2/L3): "send password reset", and the reveals of a sign-in's address and of a delivery
 * address, which share one count.
 */
export type AdminLimitedAction = 'password-reset' | 'pii-reveal';

/** The Market's limits of {@link AdminLimitedAction}, per admin account and fixed hour. */
export interface AdminActionLimitSettings {
  readonly passwordResetsPerHour: number;
  readonly piiRevealsPerHour: number;
  /** The reveal count at which one security alert is raised for the admin and window. */
  readonly piiRevealAlertAt: number;
}

/** One counted attempt: the window's count so far, this one included. */
export interface AdminActionCount {
  readonly count: number;
  /** Whole seconds until the window ends, at least 1. */
  readonly retryAfterSeconds: number;
}

/**
 * The per-admin counters of {@link AdminLimitedAction} (fixed one-hour windows shared by every API
 * instance) and the Market's limits. The subject names the admin's account with its Market. A
 * counter that cannot be read rejects; the caller fails closed.
 */
export interface AdminActionLimits {
  /** The Market's limits, or null when it has none (the actions are then refused). */
  settings(market: MarketContext): AdminActionLimitSettings | null;
  count(action: AdminLimitedAction, subject: string): Promise<AdminActionCount>;
}

export const ADMIN_ACTION_LIMITS = Symbol('ADMIN_ACTION_LIMITS');
