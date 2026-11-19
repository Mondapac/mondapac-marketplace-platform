import { auditField, defineAuditAction } from '@mondapac/shared-kernel';

// The audited actions of lists, registered at boot with
// `registerAuditActions('lists', LISTS_AUDIT_ACTIONS)`. Ids, codes and booleans only: never a
// filter name or payload. The actor is the account of the context.

/** The audit target type of a saved filter. */
export const LISTS_SAVED_FILTER_TARGET = 'lists.saved-filter';

/**
 * The lists that have saved filters, as audit codes. Audit enums are closed, so a module that
 * registers a list adds its key here too; a test fails for a registered list that is missing.
 */
export const LISTS_AUDIT_LIST_KEYS = [
  'admin.catalog.products',
  'seller.catalog.products',
  'admin.ordering.orders',
  'seller.ordering.orders',
  'admin.ordering.shipments',
  'admin.ordering.refunds',
  'admin.ordering.documents',
  'admin.system-requests.requests',
  'admin.commission-payouts.payouts',
  'admin.commission-payouts.disputes',
  'admin.payments.connected-accounts',
  'admin.wallet.credit-requests',
  'admin.customers.deletion-requests',
  'admin.blog.posts',
  'seller.commission-payouts.payouts',
] as const;
export type ListsAuditListKey = (typeof LISTS_AUDIT_LIST_KEYS)[number];

const listKey = auditField.enumOf(LISTS_AUDIT_LIST_KEYS);
const visibility = auditField.enumOf(['me', 'everyone'] as const);

/** A filter was saved for everyone in a list. */
export const ListsFilterSharedAudit = defineAuditAction({
  action: 'lists.saved-filter.shared',
  targetType: LISTS_SAVED_FILTER_TARGET,
  actors: ['authenticated'],
  after: { listKey, visibility },
});

/** A filter that is, or was, shared with everyone was renamed or moved between me and everyone. */
export const ListsFilterChangedAudit = defineAuditAction({
  action: 'lists.saved-filter.changed',
  targetType: LISTS_SAVED_FILTER_TARGET,
  actors: ['authenticated'],
  before: { visibility },
  after: {
    listKey,
    visibility,
    renamed: auditField.boolean(),
    ownedByActor: auditField.boolean(),
  },
});

/** A filter that was shared with everyone was deleted. */
export const ListsFilterRemovedAudit = defineAuditAction({
  action: 'lists.saved-filter.removed',
  targetType: LISTS_SAVED_FILTER_TARGET,
  actors: ['authenticated'],
  before: { listKey, visibility },
  after: { ownedByActor: auditField.boolean() },
});

export const LISTS_AUDIT_ACTIONS = [
  ListsFilterSharedAudit,
  ListsFilterChangedAudit,
  ListsFilterRemovedAudit,
] as const;
