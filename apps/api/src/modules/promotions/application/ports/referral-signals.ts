import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * The abuse check of a referral: whether the referrer and the new customer look like one
 * household (the same delivery address) or share a payment instrument (the same card). Both
 * facts live in `customers` and `payments`, which publish no comparison, so the adapter answers
 * `unknown`; a referral is then never rewarded on a guess: it stays pending and the check is made
 * again at the new customer's next qualifying order (fail closed).
 */
export type ReferralVerdict = 'clear' | 'same-household' | 'same-payment' | 'unknown';

export interface ReferralSignals {
  compare(
    context: CallContext,
    request: {
      readonly referrerAccountId: Id<'Account'>;
      readonly refereeAccountId: Id<'Account'>;
      /** The new customer's qualifying order. */
      readonly orderId: Id<'Order'>;
    },
  ): Promise<ReferralVerdict>;
}

export const REFERRAL_SIGNALS = Symbol('PROMOTIONS_REFERRAL_SIGNALS');
