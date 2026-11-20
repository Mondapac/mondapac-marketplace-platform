import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  AttributionFlag,
  AttributionRejectReason,
  AttributionStatus,
  InviteLink,
  SellerAttribution,
} from '../../domain/seller-invitations';

/**
 * `customers.seller_invite_links` (phase 4a). Every method runs in the open unit of the use case
 * and puts the Market (and the seller, where it reads a seller's link) in the statement.
 */
export interface InviteLinkRepository {
  /** The seller's live link; null when it has none. */
  liveOf(market: MarketContext, sellerId: Id<'Seller'>): Promise<InviteLink | null>;

  /** The link of a token, live or revoked; null for a token never drawn in the Market. */
  findByToken(market: MarketContext, token: string): Promise<InviteLink | null>;

  /**
   * Locks the link's row for the rest of the unit if it is still live (a no-op write), so that the
   * claims through a link, and a refresh that revokes it, run one after the other: the burst count
   * a claim reads is then never stale. False when the link is revoked or unknown.
   */
  lockLive(market: MarketContext, linkId: Id<'SellerInviteLink'>): Promise<boolean>;

  /**
   * Revokes the seller's live link, if any, and inserts `link` in its place. `conflict` when the
   * token or the seller's live slot was taken meanwhile by a concurrent refresh (the partial unique
   * index "one live link per seller" refuses the insert; the caller rolls the unit back).
   */
  replace(
    market: MarketContext,
    link: InviteLink,
    at: Temporal.Instant,
  ): Promise<'ok' | 'conflict'>;
}

export const INVITE_LINK_REPOSITORY = Symbol('CUSTOMERS_INVITE_LINK_REPOSITORY');

/** What an admin list of attributions selects (validated). */
export interface AttributionSelector {
  readonly view: AttributionView;
  /** The prefix of the customer's sign-in address (lower case), or null. */
  readonly emailPrefix: string | null;
  readonly sellerId: Id<'Seller'> | null;
  readonly status: AttributionStatus | null;
  readonly rejectReason: AttributionRejectReason | null;
  readonly flag: AttributionFlag | null;
  /** `YYYY-MM-DD`, inclusive, read in the zone of the query (see {@link ZonedAttributionSelector}). */
  readonly attributedFrom: string | null;
  readonly attributedTo: string | null;
}

/**
 * A selector with the IANA zone its days are read in (ADR-0005): the calling admin's own panel
 * zone, else the Market's (`AdminDayZone`). Never UTC by default.
 */
export interface ZonedAttributionSelector extends AttributionSelector {
  readonly dayZone: string;
}

export const ATTRIBUTION_VIEWS = ['suspicious', 'all', 'active', 'rejected'] as const;
export type AttributionView = (typeof ATTRIBUTION_VIEWS)[number];

/** An attribution with the directory fields the admin list shows. */
export interface AttributionListRecord extends SellerAttribution {
  readonly email: string;
  readonly displayName: string | null;
}

/** `customers.seller_attributions` (phase 4a). Every method runs in the open unit. */
export interface SellerAttributionRepository {
  findOf(market: MarketContext, accountId: Id<'Account'>): Promise<SellerAttribution | null>;

  /** Inserts the attribution; `exists` when the account already has one (nothing written). */
  insert(market: MarketContext, attribution: SellerAttribution): Promise<'ok' | 'exists'>;

  /**
   * Writes a decision when the stored version is `expectedVersion` (a conditional update); false
   * when a concurrent decision moved it.
   */
  update(
    market: MarketContext,
    attribution: SellerAttribution,
    expectedVersion: number,
  ): Promise<boolean>;

  /**
   * Attributions to the seller (through any of its links, so a refresh does not reset the count)
   * recorded at or after `since`.
   */
  countOfSellerSince(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    since: Temporal.Instant,
  ): Promise<number>;

  /**
   * The seller's active attributions recorded in each window `[from, to)` (the admin's monthly
   * trend of new exclusive customers); a window with none is 0. Rejected ones are not counted.
   */
  activeCountsOfSellerBetween(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    windows: readonly { readonly from: Temporal.Instant; readonly to: Temporal.Instant }[],
  ): Promise<readonly number[]>;

  /** The seller's attributions by status (every link of the seller). */
  countsOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<Readonly<Record<AttributionStatus, number>>>;

  /** One page of the admin list by attribution instant (the account as tie-break). */
  page(
    market: MarketContext,
    selector: ZonedAttributionSelector,
    direction: 'asc' | 'desc',
    window: { readonly offset: number; readonly limit: number },
  ): Promise<readonly AttributionListRecord[]>;

  count(market: MarketContext, selector: ZonedAttributionSelector): Promise<number>;

  /** The size of every view (ignoring the search and filters). */
  viewCounts(market: MarketContext): Promise<Readonly<Record<AttributionView, number>>>;

  /** The accounts the selector matches, newest first, at most `limit`. */
  accountIds(
    market: MarketContext,
    selector: ZonedAttributionSelector,
    limit: number,
  ): Promise<readonly Id<'Account'>[]>;

  /** The listed records of these accounts (others dropped), in the order given. */
  findListed(
    market: MarketContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<readonly AttributionListRecord[]>;
}

export const SELLER_ATTRIBUTION_REPOSITORY = Symbol('CUSTOMERS_SELLER_ATTRIBUTION_REPOSITORY');

/** Draws a new invite token (26 symbols of Crockford base32). */
export interface InviteTokens {
  next(): string;
}

export const INVITE_TOKENS = Symbol('CUSTOMERS_INVITE_TOKENS');
