// Customers management phase 2a: manual customer groups, internal notes, the activity timeline
// and the name edit, as the API answers them (docs/modules/customers/notes.md, "Phase 2, PR 2a").

import { orderHref } from '../orders/order-href.ts';

/** Change a group or its members (protected key, with the view key). */
export const GROUPS_MANAGE = 'customers.groups.manage';
export const NOTES_WRITE = 'customers.customer-notes.write';
export const CUSTOMER_EDIT = 'customers.customers.edit';

export const GROUP_NAME_MAX = 80;
export const GROUP_DESCRIPTION_MAX = 500;
export const NOTE_MAX = 2000;
export const DISPLAY_NAME_MAX = 100;
/** The API adds or removes at most this many ticked ids in one call; more go as the selector. */
export const MEMBER_IDS_MAX = 1000;
/** Chips shown on the Overview before "Show all N". */
export const GROUP_CHIPS_SHOWN = 10;

/** GET customers/admin/groups (each item) and GET customers/admin/groups/:groupId. */
export interface CustomerGroup {
  readonly groupId: string;
  readonly name: string;
  readonly description: string | null;
  readonly kind: 'manual';
  readonly archived: boolean;
  readonly archivedAt: string | null;
  readonly memberCount: number;
  readonly createdByAccountId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface CustomerGroupsAnswer {
  readonly items: readonly CustomerGroup[];
}

/** A group as a customer row names it. */
export interface GroupRef {
  readonly groupId: string;
  readonly name: string;
  readonly archived: boolean;
}

/** POST customers/admin/groups/:groupId/members/add|remove. */
export interface MembersChange {
  readonly changed: number;
  readonly requested: number;
}

/** GET customers/admin/customers/:accountId/notes. */
export interface CustomerNote {
  readonly noteId: string;
  /** Null for a note of an erased customer (its key is gone). */
  readonly body: string | null;
  readonly authorAccountId: string;
  readonly authorName: string | null;
  readonly byYou: boolean;
  readonly createdAt: string;
}

export interface CustomerNotesPage {
  readonly items: readonly CustomerNote[];
  readonly total: number;
  readonly nextCursor: string | null;
}

export const ACTIVITY_CATEGORIES = ['account', 'orders', 'admin'] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export const ACTIVITY_KINDS = [
  'signed-up',
  'email-verified',
  'name-changed',
  'account-disabled',
  'account-enabled',
  'order-paid',
  'refund-succeeded',
  'page-opened',
  'note-added',
  'group-added',
  'group-removed',
  'renamed-by-admin',
] as const;

/** One entry of POST customers/admin/customers/:accountId/activity. */
export interface ActivityEntry {
  readonly entryId: string;
  /** A kind this page may not know yet (a newer API): shown with a generic label. */
  readonly kind: string;
  readonly category: string;
  readonly occurredAt: string;
  readonly ref: { readonly type: string; readonly id: string } | null;
  readonly actor: { readonly accountId: string; readonly name: string | null } | null;
  readonly detail: string | null;
}

export interface ActivityPage {
  readonly items: readonly ActivityEntry[];
  readonly page: number;
  readonly pageSize: number;
  readonly paging: 'pages' | 'prev-next';
  /** Entries over all pages; null in `prev-next` mode (never counted). */
  readonly total: number | null;
  readonly hasNext: boolean;
}

/** The deepest entry the timeline pages reach (its page cap); narrow the filter for more. */
export const ACTIVITY_MAX_ROWS = 10_000;

export const isKnownKind = (kind: string): kind is (typeof ACTIVITY_KINDS)[number] =>
  (ACTIVITY_KINDS as readonly string[]).includes(kind);

/** Where an entry's Open goes, when it names a record the panel has a page for. */
export function activityHref(entry: ActivityEntry, accountId: string): string | null {
  if (entry.ref === null) return null;
  if (entry.ref.type === 'order') return orderHref(entry.ref.id, { accountId, tab: 'orders' });
  if (entry.ref.type === 'group') return `/customers/groups/${encodeURIComponent(entry.ref.id)}`;
  return null;
}
