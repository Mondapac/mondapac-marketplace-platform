import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/**
 * What other modules may ask `engagement` (personalization package 1a). Behaviour stays in
 * `engagement`; the recommendations of package 1d will read it through methods added here.
 */
export interface EngagementFacade {
  /**
   * Deletes everything engagement holds about an account in the Market (its behaviour and its
   * personalization switch), for account deletion. Rule `system`. Safe to call twice.
   */
  forgetAccount(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<{ readonly events: number }, AccessDenied>>;
}

export const ENGAGEMENT_FACADE = Symbol('ENGAGEMENT_FACADE');
