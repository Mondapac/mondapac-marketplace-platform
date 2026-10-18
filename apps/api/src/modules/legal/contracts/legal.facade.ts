import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/**
 * What other modules may ask `legal` (personalization package 1b). The consent record stays in
 * `legal` (ADR-0020 decision 5); notifications asks before every marketing send and withdraws
 * through the unsubscribe link. Answers carry flags only, never an address.
 */
export interface LegalFacade {
  /**
   * Whether a marketing email may be sent to this customer account now: true only after an
   * express opt-in that was not withdrawn. Rule `system`: marketing sends are jobs.
   */
  marketingEmailConsentOf(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<{ readonly granted: boolean }, AccessDenied>>;

  /**
   * Withdraws the account's marketing email consent for a one-click unsubscribe link. Rule
   * `anonymous`; the caller must have verified the link's signature first. Can only withdraw;
   * `withdrawn` is false when there was nothing to withdraw (a second click).
   */
  withdrawMarketingEmailByLink(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<{ readonly withdrawn: boolean }, AccessDenied>>;
}

export const LEGAL_FACADE = Symbol('LEGAL_FACADE');
