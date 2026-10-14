import type { Id, MarketContext } from '@mondapac/shared-kernel';

/**
 * One active member of a seller's team as the team list shows it (identity design 8.6 rows 2 and
 * 6; slice 11). The address and the name are personal data: they go to the actor entitled to
 * see them (`identity.team-member.view`), never to a log, an event or an audit row. Never the
 * credential.
 */
export interface SellerMemberSummary {
  readonly accountId: Id<'Account'>;
  /** As typed. */
  readonly email: string;
  readonly displayName: string | null;
}

/**
 * The SQL read of the seller team list (slice 11): single-statement reads over `identity`'s own
 * tables, in the caller's open unit. The seller id is a required argument (R6).
 */
export interface SellerTeamReader {
  /**
   * Up to `limit` accounts with an active membership of `sellerId` whose id is greater than
   * `after` (all when null), by id.
   */
  activeMembers(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    after: Id<'Account'> | null,
    limit: number,
  ): Promise<SellerMemberSummary[]>;
}

/** Nest token of the {@link SellerTeamReader}. */
export const SELLER_TEAM_READER = Symbol('SELLER_TEAM_READER');
