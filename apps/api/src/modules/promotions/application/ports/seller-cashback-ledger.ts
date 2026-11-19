import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';

/**
 * The seller ledger as promotions' delivery handler writes a seller's cashback into it (customers
 * phase 4c): the seller pays its exclusive customer's cashback from the payout of the same seller
 * order. Idempotent per credit. `false` when the ledger refused or could not be reached: the
 * handler retries the delivery (the wallet credit is idempotent too).
 */
export interface SellerCashbackLedger {
  record(
    context: CallContext,
    cashback: {
      readonly creditId: Id<'PromotionCredit'>;
      readonly orderId: Id<'Order'>;
      readonly sellerOrderId: Id<'SellerOrder'>;
      readonly sellerId: Id<'Seller'>;
      readonly amount: bigint;
      readonly currency: string;
      readonly creditedAt: Temporal.Instant;
    },
  ): Promise<boolean>;

  /**
   * Credits back to the seller what a refund took back of its cashback (customers phase 4c-2).
   * Idempotent per clawback; `false` when the ledger refused or could not be reached (retried).
   */
  recordReturn(
    context: CallContext,
    returned: {
      readonly clawbackId: Id<'CreditClawback'>;
      readonly creditId: Id<'PromotionCredit'>;
      readonly orderId: Id<'Order'>;
      readonly sellerOrderId: Id<'SellerOrder'>;
      readonly sellerId: Id<'Seller'>;
      readonly amount: bigint;
      readonly currency: string;
      readonly returnedAt: Temporal.Instant;
    },
  ): Promise<boolean>;
}

export const SELLER_CASHBACK_LEDGER = Symbol('PROMOTIONS_SELLER_CASHBACK_LEDGER');
