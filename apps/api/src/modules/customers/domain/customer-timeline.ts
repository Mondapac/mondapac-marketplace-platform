import type { Id, Temporal } from '@mondapac/shared-kernel';

// A customer's activity timeline (customers management phase 2, PR 2a): what happened to the
// customer, copied from the events of the owning modules and written by customers' own admin
// actions. Codes and ids only, never a name, an address, an amount or free text: the page shows a
// label per kind and links an order or a group by its id.

/** What the customer (or the platform) did, copied from another module's event. */
export const CUSTOMER_EVENT_KINDS = [
  'signed-up',
  'email-verified',
  'name-changed',
  'account-disabled',
  'account-enabled',
  'order-paid',
  'refund-succeeded',
  // Phase 2b, part 3: reviews' events, on the review's author (looked up through reviews' facade
  // by the system: the events carry no account on purpose). Submitted and published at once, or
  // released from a hold; held by the automatic checks; hidden or removed, and restored, by a
  // moderator.
  'review-published',
  'review-held',
  'review-hidden',
  'review-restored',
  // Phase 2b, part 4: legal's consent event. The entry names the channel (its `detail`), never
  // the value: legal's event carries none.
  'consent-changed',
] as const;

/**
 * The kinds copied from legal's consent events. Shown only with legal's own key as well: only
 * real changes are recorded and the default is "not granted", so the number of entries alone
 * tells whether the consent stands now.
 */
export const CONSENT_EVENT_KINDS = ['consent-changed'] as const;
export type ConsentEventKind = (typeof CONSENT_EVENT_KINDS)[number];

/** The kinds copied from reviews' events, found through the review's author. */
export const REVIEW_EVENT_KINDS = [
  'review-published',
  'review-held',
  'review-hidden',
  'review-restored',
] as const;
export type ReviewEventKind = (typeof REVIEW_EVENT_KINDS)[number];

/** What an admin did on the customer's page (the admin is the entry's actor). */
export const ADMIN_ACTION_KINDS = [
  'page-opened',
  'note-added',
  'group-added',
  'group-removed',
  'renamed-by-admin',
  'address-revealed',
  // Phase 2b, the security section: identity did it and audited it; customers notes it here.
  'sign-in-address-revealed',
  'signed-out-by-admin',
  'password-reset-sent',
] as const;

export const TIMELINE_KINDS = [...CUSTOMER_EVENT_KINDS, ...ADMIN_ACTION_KINDS] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/** The filter groups of the timeline's super list ("event type"). */
export const TIMELINE_CATEGORIES = ['account', 'orders', 'reviews', 'admin'] as const;
export type TimelineCategory = (typeof TIMELINE_CATEGORIES)[number];

export const categoryOf = (kind: TimelineKind): TimelineCategory => {
  switch (kind) {
    case 'order-paid':
    case 'refund-succeeded':
      return 'orders';
    case 'review-published':
    case 'review-held':
    case 'review-hidden':
    case 'review-restored':
      return 'reviews';
    case 'page-opened':
    case 'note-added':
    case 'group-added':
    case 'group-removed':
    case 'renamed-by-admin':
    case 'address-revealed':
    case 'sign-in-address-revealed':
    case 'signed-out-by-admin':
    case 'password-reset-sent':
      return 'admin';
    default:
      return 'account';
  }
};

export const kindsOf = (category: TimelineCategory): readonly TimelineKind[] =>
  TIMELINE_KINDS.filter((kind) => categoryOf(kind) === category);

export type TimelineRefType = 'order' | 'refund' | 'group' | 'note';

/** One entry as stored. */
export interface TimelineEntry {
  readonly id: Id<'CustomerTimelineEntry'>;
  readonly accountId: Id<'Account'>;
  readonly occurredAt: Temporal.Instant;
  readonly kind: TimelineKind;
  readonly ref: { readonly type: TimelineRefType; readonly id: string } | null;
  /** The admin who did it, for an admin action; null for the customer's own or the system's. */
  readonly actorAccountId: Id<'Account'> | null;
  /** A short code (the tab opened), or null. */
  readonly detail: string | null;
  /** The event the entry was copied from; null for an admin action. */
  readonly sourceEventId: string | null;
}

/** The newest entries the Overview shows ("last five events"). */
export const TIMELINE_OVERVIEW_SIZE = 5;

/**
 * What a consumed event names: the account (with the consent channel), or the order (and refund)
 * or review to find it from.
 */
export type CustomerEventKindInput =
  | {
      readonly kind: Exclude<
        (typeof CUSTOMER_EVENT_KINDS)[number],
        'order-paid' | 'refund-succeeded' | ReviewEventKind | ConsentEventKind
      >;
      readonly accountId: string;
    }
  | { readonly kind: ConsentEventKind; readonly accountId: string; readonly channel: string }
  | { readonly kind: ReviewEventKind; readonly reviewId: string }
  | { readonly kind: 'order-paid'; readonly orderId: string }
  | { readonly kind: 'refund-succeeded'; readonly orderId: string; readonly refundId: string };
