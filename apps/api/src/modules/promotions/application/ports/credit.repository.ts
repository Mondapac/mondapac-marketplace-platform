import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  CreditKind,
  CreditRecord,
  ReferralRecord,
  ReferralRejectReason,
  ReferralStatus,
} from '../../domain/credit';

/** Where a page of credits ends: the creation instant and id of its last row. */
export interface CreditCursor {
  readonly createdAt: Temporal.Instant;
  readonly id: Id<'PromotionCredit'>;
}

/** The credits a promotion owes or has paid (`promotions.credit_issuances`). */
export interface CreditRepository {
  /**
   * `duplicate`: a credit of this kind already exists for the source (the repeat of an event).
   * A RECORDED credit has its own slot per kind and source, apart from the real ones (PENDING,
   * GRANTED, FAILED), so a test-mode record never keeps a real credit from being made.
   */
  insert(market: MarketContext, record: CreditRecord): Promise<'inserted' | 'duplicate'>;
  /** The credit of a source; a real one (not RECORDED) wins over a RECORDED one. */
  findBySource(
    market: MarketContext,
    kind: CreditKind,
    sourceId: string,
  ): Promise<CreditRecord | null>;
  /** Moves a PENDING credit to GRANTED or FAILED; false when it was not PENDING any more. */
  settle(
    market: MarketContext,
    id: Id<'PromotionCredit'>,
    result:
      | { readonly status: 'GRANTED'; readonly walletJournalId: string }
      | { readonly status: 'FAILED'; readonly failureCode: string },
    at: Temporal.Instant,
  ): Promise<boolean>;
  /** The money a promotion has reserved or paid: its PENDING and GRANTED credits. */
  reservedTotal(market: MarketContext, promotionId: Id<'Promotion'>): Promise<bigint>;
  /** PENDING and GRANTED credits of one promotion, optionally of one recipient. */
  countLive(
    market: MarketContext,
    promotionId: Id<'Promotion'>,
    recipient?: Id<'Account'>,
  ): Promise<number>;
  /**
   * What one order has been credited by one kind (PENDING and GRANTED; a RECORDED test-mode credit
   * is not money): the cashback cap is per order.
   */
  creditedForOrder(market: MarketContext, orderId: Id<'Order'>, kind: CreditKind): Promise<bigint>;
  /** Newest first, `limit` rows after the cursor (keyset: the last row of the previous page). */
  listForPromotion(
    market: MarketContext,
    promotionId: Id<'Promotion'>,
    limit: number,
    after?: CreditCursor,
  ): Promise<readonly CreditRecord[]>;
}

export const CREDIT_REPOSITORY = Symbol('PROMOTIONS_CREDIT_REPOSITORY');

export interface ReferralCodeRecord {
  readonly accountId: Id<'Account'>;
  readonly codeHash: string;
  readonly createdAt: Temporal.Instant;
}

/** Referral codes and referrals (`promotions.referral_codes`, `promotions.referrals`). */
export interface ReferralRepository {
  findCode(market: MarketContext, accountId: Id<'Account'>): Promise<ReferralCodeRecord | null>;
  findCodeByHash(market: MarketContext, codeHash: string): Promise<ReferralCodeRecord | null>;
  /** `duplicate`: the customer already has a code or the hash is taken. */
  insertCode(market: MarketContext, record: ReferralCodeRecord): Promise<'inserted' | 'duplicate'>;

  /** The referral that a delivered seller order qualified, if any. */
  findQualifiedBySellerOrder(
    market: MarketContext,
    sellerOrderId: Id<'SellerOrder'>,
  ): Promise<ReferralRecord | null>;
  /** The referral of a new customer (a customer is referred once in a Market). */
  findByReferee(
    market: MarketContext,
    refereeAccountId: Id<'Account'>,
  ): Promise<ReferralRecord | null>;
  /** `duplicate`: the customer was referred already. */
  insert(market: MarketContext, record: ReferralRecord): Promise<'inserted' | 'duplicate'>;
  /** Moves a PENDING referral to its decision; false when it was not PENDING any more. */
  decide(
    market: MarketContext,
    id: Id<'Referral'>,
    decision:
      | {
          readonly status: 'QUALIFIED';
          readonly orderId: Id<'Order'>;
          readonly sellerOrderId: Id<'SellerOrder'>;
        }
      | { readonly status: 'REJECTED'; readonly reason: ReferralRejectReason }
      | { readonly status: 'EXPIRED' },
    at: Temporal.Instant,
  ): Promise<boolean>;
  /**
   * How many referrals of a referrer under a promotion are in this status. `notExpiredAt`: only
   * those whose window is still open at that instant (a PENDING referral past its window is
   * waiting to be marked EXPIRED, not pending in any useful sense).
   */
  countByReferrer(
    market: MarketContext,
    referrerAccountId: Id<'Account'>,
    promotionId: Id<'Promotion'>,
    status: ReferralStatus,
    notExpiredAt?: Temporal.Instant,
  ): Promise<number>;
  /** How many referrals of a promotion are in this status. */
  countByPromotion(
    market: MarketContext,
    promotionId: Id<'Promotion'>,
    status: ReferralStatus,
  ): Promise<number>;
  /** A referrer's referrals, newest first. */
  listByReferrer(
    market: MarketContext,
    referrerAccountId: Id<'Account'>,
    limit: number,
  ): Promise<readonly ReferralRecord[]>;
}

export const REFERRAL_REPOSITORY = Symbol('PROMOTIONS_REFERRAL_REPOSITORY');
