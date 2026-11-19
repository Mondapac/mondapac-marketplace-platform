import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';

/**
 * The wallet credit a promotion pays, through `wallet`'s facade (`grantCredit`, source `promo`,
 * reason `promotion`). The idempotency key makes a repeat harmless: the same key and request
 * answer the first result again. Never called inside a unit.
 */
export type WalletCreditFailure =
  /** Worth trying again later: the wallet is off, paused, frozen or unavailable, or the call was refused for a temporary reason. */
  | { readonly retry: true; readonly code: string }
  /** The wallet refused for good (the customer's wallet is closed or over its cap). */
  | { readonly retry: false; readonly code: string };

export interface WalletCredit {
  grant(
    context: CallContext,
    request: {
      readonly accountId: Id<'Account'>;
      readonly amount: Money;
      readonly orderId: Id<'Order'> | null;
      readonly idempotencyKey: string;
    },
  ): Promise<Result<{ readonly journalId: string }, WalletCreditFailure>>;

  /**
   * Takes back up to `amount` of what is left of the grant made by `grantJournalId` (customers
   * phase 4c-2: a refund after a cashback was credited; reason `cashback-refund`). Answers what was
   * taken (zero when nothing was left) and its journal (null then). Same key, same answer.
   */
  clawBack(
    context: CallContext,
    request: {
      readonly accountId: Id<'Account'>;
      readonly grantJournalId: string;
      readonly amount: Money;
      readonly orderId: Id<'Order'> | null;
      readonly idempotencyKey: string;
    },
  ): Promise<
    Result<{ readonly journalId: string | null; readonly clawedBack: bigint }, WalletCreditFailure>
  >;
}

export const WALLET_CREDIT = Symbol('PROMOTIONS_WALLET_CREDIT');
