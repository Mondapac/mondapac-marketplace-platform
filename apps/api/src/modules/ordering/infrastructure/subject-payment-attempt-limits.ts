import type { SubjectRateLimits } from '../../../platform/rate-limit/subject-rate-limits';
import type { PaymentAttemptLimits } from '../application/ports/payment-attempt-limits';

/** {@link PaymentAttemptLimits} on the platform's shared counters, class `checkout-payment`. */
export class SubjectPaymentAttemptLimits implements PaymentAttemptLimits {
  constructor(private readonly counters: SubjectRateLimits) {}

  count(subject: string) {
    return this.counters.count('checkout-payment', subject);
  }
}
