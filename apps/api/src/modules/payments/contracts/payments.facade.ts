import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** Whether Stripe can pay one seller. */
export interface PayoutReadiness {
  readonly sellerId: string;
  readonly ready: boolean;
}

/**
 * What other modules ask of `payments`. Takes the caller's `CallContext` unchanged, so the
 * use case's gate runs.
 */
export interface PaymentsFacade {
  /**
   * For up to 100 seller ids, whether the stored payout account is enabled. Answers from the
   * stored state, with no call to Stripe; an unknown seller (or one of another Market) is
   * `ready: false`.
   */
  payoutReadiness(
    context: CallContext,
    sellerIds: readonly string[],
  ): Promise<
    Result<readonly PayoutReadiness[], AccessDenied | { readonly code: 'validation.failed' }>
  >;
}

/** Nest token of the {@link PaymentsFacade}, provided and exported by `PaymentsModule`. */
export const PAYMENTS_FACADE = Symbol('PAYMENTS_FACADE');
