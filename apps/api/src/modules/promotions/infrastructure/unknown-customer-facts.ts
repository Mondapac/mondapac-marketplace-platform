import type { ReferralSignals, ReferralVerdict } from '../application/ports/referral-signals';

// Fail-closed adapters for the reads that no module publishes yet (phase 3). Each answers
// "unknown", which every caller treats as "no": the customer-group discount is
// not offered, a referral is refused or left pending, and a credit is never issued on a guess.
// Replace each one with a facade-backed adapter in `promotions-providers.ts` when the owning
// module publishes the read.

/** Household and payment comparisons are not published by `customers` or `payments`. */
export class UnknownReferralSignals implements ReferralSignals {
  compare(): Promise<ReferralVerdict> {
    return Promise.resolve('unknown');
  }
}
