import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/**
 * What the sign-in flow may call to cancel a pending deletion request (the design says signing
 * in during the wait cancels). The caller's `CallContext` goes unchanged; the account is the
 * session's. Not exposed over HTTP. Nothing calls it yet: identity has no post-sign-in hook, and
 * identity may not import another module (notes.md, package 5b).
 */
export interface CustomersAccountDeletionFacade {
  /**
   * Cancels the calling customer's pending request with the reason `sign-in`; a request the job
   * has already claimed answers `customers.account-deletion-in-progress`.
   */
  cancelPendingOnSignIn(
    context: CallContext,
  ): Promise<
    Result<
      { readonly code: 'cancelled' },
      | AccessDenied
      | { readonly code: 'customers.account-deletion-request-not-found' }
      | { readonly code: 'customers.account-deletion-in-progress' }
      | { readonly code: 'customers.conflict' }
    >
  >;
}

/** Nest token of the {@link CustomersAccountDeletionFacade}, provided by `CustomersAccountDeletionModule`. */
export const CUSTOMERS_ACCOUNT_DELETION_FACADE = Symbol('CUSTOMERS_ACCOUNT_DELETION_FACADE');
