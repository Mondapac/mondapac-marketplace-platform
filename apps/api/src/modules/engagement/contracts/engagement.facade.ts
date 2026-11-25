import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { SearchShoppers } from '../domain/search-shoppers';
import type { ShoppingFunnelCounts } from '../domain/shopping-funnel';

/**
 * What the caller must pass besides its `CallContext` to read a subject's recent views: the
 * browser's privacy signals and, for a guest, the raw engagement guest cookie token. The subject
 * itself is the context's customer account or that token, never a request field.
 */
export interface RecentViewsRequest {
  /** `Sec-GPC: 1` on the request: the answer is empty. */
  readonly globalPrivacyControl: boolean;
  /** `Engagement-Consent: granted` on the request (guests only; a customer's switch applies). */
  readonly consent: boolean;
  /** The raw engagement guest cookie token (guests only); null when there is none. */
  readonly guestToken: string | null;
}

/** A subject's recently viewed ids: distinct, newest first, at most 50 of each. Ids only. */
export interface RecentViews {
  readonly productIds: readonly Id<'Product'>[];
  readonly categoryIds: readonly Id<'Category'>[];
}

/**
 * What other modules may ask `engagement` (personalization package 1a). Behaviour stays in
 * `engagement`; the recommendations of package 1d read it through the methods here.
 */
export interface EngagementFacade {
  /**
   * Deletes everything engagement holds about an account in the Market (its behaviour and its
   * personalization switch), for account deletion. Rule `system`. Safe to call twice.
   */
  forgetAccount(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<{ readonly events: number }, AccessDenied>>;

  /**
   * The recently viewed product and category ids of the subject of the call: the signed-in
   * customer, or the guest named by `request.guestToken`, in the call's Market only. Distinct,
   * newest first, at most 50 of each; ids only. Empty, and nothing read, with `Sec-GPC: 1`, with
   * the customer's personalization switch off, and for a guest without consent or a well-formed
   * token. Reads only: never records, never sets, extends or clears a cookie. Two use cases
   * behind this method (`own-resources` for a customer, `anonymous` for a guest), chosen by the
   * call's actor. An unreadable store rejects the call: the consumer fails closed.
   */
  recentViews(
    context: CallContext,
    request: RecentViewsRequest,
  ): Promise<Result<RecentViews, AccessDenied>>;

  /**
   * Which of `sellerIds` (at most 100) the account follows, for the store-follower offer
   * (customers management phase 3). Two use cases behind this method, chosen by the call's actor:
   * `system` (any account, the quote at checkout) and `own-resources` (a customer about their own
   * account only; any other account is `access.denied`). Ids only. A store that is no longer public
   * still counts as followed until the customer unfollows it.
   */
  followedAmong(
    context: CallContext,
    accountId: Id<'Account'>,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Result<readonly Id<'Seller'>[], StoreFollowReadFailure>>;

  /**
   * Every store an account follows with the instant the follow started (at most 1000), for
   * `customers`' per-seller read model. Rule `system`. Ids and instants only.
   */
  followsOfAccount(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<readonly AccountStoreFollow[], StoreFollowReadFailure>>;

  /**
   * The signed-in customer follows a published store, as the storefront's Follow button does (the
   * automatic follow of a customer who joined through the store's invite link, customers management
   * phase 4a). Rule `own-resources`: the account is the session's; any other actor and a Login-as
   * session are `access.denied`. Following a store already followed changes nothing.
   */
  followStore(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<Result<{ readonly following: boolean }, StoreFollowWriteFailure>>;

  /**
   * The shopping funnel of one window as four counts (dashboards v2, phase 2): signed-in
   * customers with personalization on who viewed a product, of them those who added to the cart,
   * of them those of `request.checkouts` who placed an order, and of them those who paid. Guests
   * are never counted. Rule `system` (reporting's nightly snapshot). Counts only.
   */
  shoppingFunnel(
    context: CallContext,
    request: ShoppingFunnelRequest,
  ): Promise<Result<ShoppingFunnelCounts, ShoppingFunnelFailure>>;

  /**
   * For the texts named (search's zero-result notes of one window), the distinct signed-in
   * customers with personalization on who searched each in the window and their searches; only
   * texts searched by at least ten distinct customers are answered (dashboards v2, phase 2).
   * Guests are never counted. Rule `system` (reporting's nightly snapshot). Counts only.
   */
  searchShoppers(
    context: CallContext,
    request: SearchShoppersRequest,
  ): Promise<Result<readonly SearchShoppers[], SearchShoppersFailure>>;
}

/**
 * What reporting's nightly snapshot asks the searchers of (dashboards v2, phase 2): one window (a
 * Market day, at most 26 hours) and the folded texts search found nothing for in it (at most
 * 2,000, each 1 to 200 characters). Texts only; no person is named.
 */
export interface SearchShoppersRequest {
  readonly window: { readonly from: Temporal.Instant; readonly to: Temporal.Instant };
  readonly queries: readonly string[];
}

/** A text searched by at least ten distinct customers in the window, with its counts. */
export type { SearchShoppers };

export type SearchShoppersFailure =
  | AccessDenied
  | { readonly code: 'validation.failed' }
  | { readonly code: 'engagement.search-too-large' };

/**
 * What reporting's nightly snapshot asks the shopping funnel of (dashboards v2, phase 2): one
 * window (a Market day, at most 26 hours) and the accounts that placed an order in it, with
 * whether one of those orders was paid (ordering's, at most 5,000). The ids are only matched
 * against engagement's population; they are never stored, returned or logged.
 */
export interface ShoppingFunnelRequest {
  readonly window: { readonly from: Temporal.Instant; readonly to: Temporal.Instant };
  readonly checkouts: readonly {
    readonly accountId: Id<'Account'>;
    readonly paid: boolean;
  }[];
}

/** The shopping funnel of a window: distinct accounts, each step within the one before. */
export type { ShoppingFunnelCounts };

export type ShoppingFunnelFailure =
  | AccessDenied
  | { readonly code: 'validation.failed' }
  | { readonly code: 'engagement.funnel-too-large' };

/** Why a follow through the facade was refused. */
export type StoreFollowWriteFailure =
  | AccessDenied
  | { readonly code: 'validation.failed' }
  | { readonly code: 'engagement.store-not-found' }
  | { readonly code: 'engagement.follow-limit' }
  | { readonly code: 'engagement.unavailable' };

/** One store an account follows. */
export interface AccountStoreFollow {
  readonly sellerId: Id<'Seller'>;
  readonly followedAt: Temporal.Instant;
}

export type StoreFollowReadFailure =
  | AccessDenied
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: string };

export const ENGAGEMENT_FACADE = Symbol('ENGAGEMENT_FACADE');
