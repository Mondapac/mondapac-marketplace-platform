/** One counted card payment attempt of a customer: the window's count so far, this one included. */
export interface PaymentAttemptCount {
  readonly count: number;
  /** Whole seconds until the window ends, at least 1. */
  readonly retryAfterSeconds: number;
}

/**
 * Counts the card payment attempts of one customer account (fixed window), shared by every API
 * instance. The subject is the account id with its Market. A counter that cannot be read
 * rejects; the caller fails closed.
 */
export interface PaymentAttemptLimits {
  count(subject: string): Promise<PaymentAttemptCount>;
}

export const PAYMENT_ATTEMPT_LIMITS = Symbol('PAYMENT_ATTEMPT_LIMITS');
