import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition, Id, Temporal } from '@mondapac/shared-kernel';

// A customer follows a seller's store (customers management phase 3). The follow belongs to the
// customer: they add it and remove it, and it goes when their account is erased. A seller learns
// only that a customer of its own follows it, through `customers`' per-seller read model (a code
// and a first name), never the account.

/** One follow: a customer account and a seller's store in one Market. */
export interface StoreFollow {
  readonly id: Id<'StoreFollow'>;
  readonly accountId: Id<'Account'>;
  readonly sellerId: Id<'Seller'>;
  readonly followedAt: Temporal.Instant;
}

/** The most stores one customer may follow in a Market. */
export const MAX_FOLLOWS_PER_ACCOUNT = 1000;
/** The most follows of the customer's "My stores" per page. */
export const MAX_MY_STORES_PAGE = 100;
export const DEFAULT_MY_STORES_PAGE = 50;

// The aggregate of both events is the follow row: version 1 is the follow, version 2 its end. A
// follow after an unfollow is a new aggregate. The account and the seller travel as ids so that
// `customers` can refresh that customer's per-seller rows; no name, address or other data.

/** A customer started following a seller's store. */
export const StoreFollowedEvent = defineEvent({
  type: 'engagement.store-followed.v1',
  aggregateType: 'store-follow',
  payload: {
    accountId: eventField.id(),
    sellerId: eventField.id(),
  },
});

/** A customer stopped following a seller's store (not sent when the account is erased). */
export const StoreUnfollowedEvent = defineEvent({
  type: 'engagement.store-unfollowed.v1',
  aggregateType: 'store-follow',
  payload: {
    accountId: eventField.id(),
    sellerId: eventField.id(),
  },
});

export const ENGAGEMENT_EVENTS: readonly EventDefinition[] = [
  StoreFollowedEvent,
  StoreUnfollowedEvent,
];
