import type {
  CustomerOrderHistory,
  Known,
  StoreFollows,
} from '../application/ports/customer-facts';
import type {
  DeliveredOrderFacts,
  DeliveredSellerOrderFacts,
} from '../application/ports/order-facts';
import type { ReferralSignals, ReferralVerdict } from '../application/ports/referral-signals';

// Fail-closed adapters for the reads that no module publishes yet (phase 3). Each answers
// "unknown", which every caller treats as "no": the customer-group and store-follower discounts
// are not offered, a referral is refused or left pending, and a credit is never issued on a guess.
// Replace each one with a facade-backed adapter in `promotions-providers.ts` when the owning
// module publishes the read.

/** `ordering` and `customers` publish no last-order read. */
export class UnknownCustomerOrderHistory implements CustomerOrderHistory {
  lastOrderAt(): Promise<Known<never>> {
    return Promise.resolve({ known: false });
  }
}

/** No module owns store follows. */
export class UnknownStoreFollows implements StoreFollows {
  followedAmong(): Promise<Known<never>> {
    return Promise.resolve({ known: false });
  }
}

/** `ordering` publishes the delivered event with ids only and no read of the order's amount or customer. */
export class UnknownDeliveredOrderFacts implements DeliveredOrderFacts {
  read(): Promise<Known<DeliveredSellerOrderFacts>> {
    return Promise.resolve({ known: false });
  }
}

/** Household and payment comparisons are not published by `customers` or `payments`. */
export class UnknownReferralSignals implements ReferralSignals {
  compare(): Promise<ReferralVerdict> {
    return Promise.resolve('unknown');
  }
}
