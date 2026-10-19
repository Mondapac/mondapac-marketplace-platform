import type { CallContext } from '@mondapac/shared-kernel';

/**
 * The READ tool `notifications` publishes for the buyer assistant (ADR-0019 decision 6, R3): the
 * Market's public support email, through the sign-in pages' own use case (rule `anonymous`) with
 * the caller's `CallContext` unchanged. null when the Market has none set.
 */
export interface SupportContactFacade {
  publicEmail(context: CallContext): Promise<string | null>;
}

export const SUPPORT_CONTACT_FACADE = Symbol('SUPPORT_CONTACT_FACADE');
