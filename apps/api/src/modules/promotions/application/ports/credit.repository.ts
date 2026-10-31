import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  CreditKind,
  CreditRecord,
  ReferralRecord,
  ReferralRejectReason,
  ReferralStatus,
} from '../../domain/credit';

/** The credits a promotion owes or has paid (`promotions.credit_issuances`). */
export interface CreditRepository {
  /** `duplicate`: a credit of this kind already exists for the source (the repeat of an event). */
  insert(market: MarketContext, record: CreditRecord): Promise<'inserted' | 'duplicate'>;
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
  /** What one order has been credited by one kind (PENDING, GRANTED and RECORDED): the cashback cap is per order. */
  creditedForOrder(market: MarketContext, orderId: Id<'Order'>, kind: CreditKind): Promise<bigint>;
  /** Newest first. */
  listForPromotion(
    market: MarketContext,
    promotionId: Id<'Promotion'>,
    limit: number,
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
  /** How many referrals of a referrer under a promotion are in this status. */
  countByReferrer(
    market: MarketContext,
    referrerAccountId: Id<'Account'>,
    promotionId: Id<'Promotion'>,
    status: ReferralStatus,
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
