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
] as const;

/** What an admin did on the customer's page (the admin is the entry's actor). */
export const ADMIN_ACTION_KINDS = [
  'page-opened',
  'note-added',
  'group-added',
  'group-removed',
  'renamed-by-admin',
] as const;

export const TIMELINE_KINDS = [...CUSTOMER_EVENT_KINDS, ...ADMIN_ACTION_KINDS] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/** The filter groups of the timeline's super list ("event type"). */
export const TIMELINE_CATEGORIES = ['account', 'orders', 'admin'] as const;
export type TimelineCategory = (typeof TIMELINE_CATEGORIES)[number];

export const categoryOf = (kind: TimelineKind): TimelineCategory => {
  switch (kind) {
    case 'order-paid':
    case 'refund-succeeded':
      return 'orders';
    case 'page-opened':
    case 'note-added':
    case 'group-added':
    case 'group-removed':
    case 'renamed-by-admin':
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

/** What a consumed event names: the account, or the order (and refund) to find it from. */
export type CustomerEventKindInput =
  | {
      readonly kind: Exclude<
        (typeof CUSTOMER_EVENT_KINDS)[number],
        'order-paid' | 'refund-succeeded'
      >;
      readonly accountId: string;
    }
  | { readonly kind: 'order-paid'; readonly orderId: string }
  | { readonly kind: 'refund-succeeded'; readonly orderId: string; readonly refundId: string };
