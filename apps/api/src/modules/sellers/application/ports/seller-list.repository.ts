import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { ListCursor, ListKind, ListSearch } from '../../domain/seller-list';

/**
 * One seller of the admin list: clear columns of `sellers`' own rows only (sellers design 7.8;
 * Hassan M4). No ciphertext is selected, so no key is used, and nothing from `identity` is here:
 * the access state is read once per page from `identity`'s contract.
 */
export interface ListedSeller {
  readonly sellerId: Id<'Seller'>;
  readonly origin: 'self' | 'invitation';
  readonly storeName: string | null;
  /** The slug the seller holds, if any. */
  readonly heldSlug: string | null;
  /** The slug of the draft (clear, not public), shown only when no slug is held yet. */
  readonly draftSlug: string | null;
  readonly serviceAreaCode: string | null;
  readonly operatingTimezone: string | null;
  readonly draftComplete: boolean;
  readonly hasApprovedRevision: boolean;
  /** Whether an address is saved (a null check on the ciphertext; it is never read). */
  readonly hasAddress: boolean;
  readonly createdAt: Temporal.Instant;
  readonly lastChangedAt: Temporal.Instant;
  /** The pending submission, or null. */
  readonly pending: {
    readonly revisionId: Id<'BusinessFileRevision'>;
    readonly kind: ListKind;
    readonly revisionNo: number;
    readonly submittedAt: Temporal.Instant;
  } | null;
}

/** What a page is asked to read. `take` is one more than the page, to learn whether more follow. */
export interface ListPageQuery {
  readonly kind: ListKind | null;
  readonly outsideArea: boolean;
  /** Codes of the areas that take new sellers now, for the outside-area filter. */
  readonly openAreaCodes: readonly string[];
  /** When set, only these sellers (the candidates of a search). */
  readonly onlyIds: readonly Id<'Seller'>[] | null;
  readonly after: ListCursor | null;
  readonly take: number;
}

export interface ListCounts {
  readonly awaitingReview: { readonly onboarding: number; readonly identityChange: number };
  readonly incomplete: number;
  readonly all: number;
}

export interface SearchCandidates {
  readonly ids: readonly Id<'Seller'>[];
  /** True when more matched than the cap: the term is too broad to list safely. */
  readonly overflow: boolean;
}

/**
 * The reads of the admin seller list (sellers data design A3 to A6, 7). Every method runs in the
 * open unit of the use case, names the Market in every statement and reads `sellers`' own tables
 * only (no join into another module). A seller of another Market is never returned.
 */
export interface SellerListRepository {
  /** "Awaiting review": pending submissions, oldest first (A3). */
  awaitingReview(market: MarketContext, query: ListPageQuery): Promise<readonly ListedSeller[]>;

  /**
   * "Incomplete": never approved, no pending submission, draft not complete, most recently
   * changed first (A4).
   */
  incomplete(market: MarketContext, query: ListPageQuery): Promise<readonly ListedSeller[]>;

  /** "All": every file, newest first (the id is a UUID v7, so it is creation order). */
  all(market: MarketContext, query: ListPageQuery): Promise<readonly ListedSeller[]>;

  /** The counts the tabs show. */
  counts(market: MarketContext): Promise<ListCounts>;

  /**
   * The sellers a search names: the store-name key prefix (A6) and the held-slug prefix (A7). At
   * most `cap` ids; `overflow` when more matched.
   */
  searchCandidates(
    market: MarketContext,
    search: ListSearch,
    cap: number,
  ): Promise<SearchCandidates>;
}

export const SELLER_LIST_REPOSITORY = Symbol('SELLER_LIST_REPOSITORY');
