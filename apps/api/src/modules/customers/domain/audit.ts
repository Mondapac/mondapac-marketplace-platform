import { auditField, defineAuditAction } from '@mondapac/shared-kernel';

// The audited action of customers (account deletion setting), registered at boot with
// `registerAuditActions('customers', CUSTOMERS_AUDIT_ACTIONS)`. An audit field holds no free text,
// so the row names the versions and the two values; the reason an admin gave is in the
// insert-only `customers.account_deletion_settings` history, which is part of the audit
// evidence: it must never be granted UPDATE or DELETE.

/** The audit target type of the account deletion setting. */
export const ACCOUNT_DELETION_SETTINGS_TARGET = 'customers.account-deletion-settings';

const SNAPSHOT = {
  version: auditField.integer(),
  enabled: auditField.boolean(),
  waitingPeriodDays: auditField.integer(),
};

/**
 * An admin changed the Market's account deletion setting. `version` 0 is the built-in default.
 * `after` names the admin step-up proof the change spent, as the wallet switch's row does.
 */
export const AccountDeletionSettingsChanged = defineAuditAction({
  action: 'customers.account-deletion-settings.changed',
  targetType: ACCOUNT_DELETION_SETTINGS_TARGET,
  targetId: auditField.enumOf(['account-deletion-settings'] as const),
  actors: ['authenticated'],
  before: SNAPSHOT,
  after: {
    ...SNAPSHOT,
    /** The admin step-up proof the change spent: the session that verified the code, and when. */
    stepUpSessionId: auditField.id(),
    stepUpVerifiedAt: auditField.instant(),
  },
});

/** The audit target type of an account deletion request. */
export const ACCOUNT_DELETION_REQUEST_TARGET = 'customers.account-deletion-request';

/**
 * A buyer asked to delete their account (package 5b). Target: the request; the actor is the buyer
 * on the session that asked (the audit row's actor, as every row). No free text and no personal
 * data: the waiting period and the scheduled instant.
 */
export const AccountDeletionRequested = defineAuditAction({
  action: 'customers.account-deletion.requested',
  targetType: ACCOUNT_DELETION_REQUEST_TARGET,
  actors: ['authenticated'],
  after: {
    waitingPeriodDays: auditField.integer(),
    scheduledFor: auditField.instant(),
  },
});

/** The buyer cancelled a pending request (`customer`), or signed in during the wait (`sign-in`). */
export const AccountDeletionCancelled = defineAuditAction({
  action: 'customers.account-deletion.cancelled',
  targetType: ACCOUNT_DELETION_REQUEST_TARGET,
  actors: ['authenticated'],
  after: { reason: auditField.enumOf(['customer', 'sign-in'] as const) },
});

/** The deletion job carried a request out: the account is erased. Written by the system actor. */
export const AccountDeletionCompleted = defineAuditAction({
  action: 'customers.account-deletion.completed',
  targetType: ACCOUNT_DELETION_REQUEST_TARGET,
  actors: ['system'],
  after: { waitingPeriodDays: auditField.integer() },
});

const STEP_UP_PROOF = {
  /** The admin step-up proof the action spent: the session that verified the code, and when. */
  stepUpSessionId: auditField.id(),
  stepUpVerifiedAt: auditField.instant(),
};

/**
 * An admin asked for a buyer's account to be deleted (package 5c). Target: the request; the actor
 * is the admin. No free text: the ticket reference and the reason are on the request row
 * (`customers.account_deletion_requests`); the reason is redacted (set to NULL) when the request
 * closes and the ticket reference stays, and the row is part of the audit evidence. `after` names the buyer's account, the dates and the step-up proof the request spent.
 */
export const AccountDeletionRequestedByAdmin = defineAuditAction({
  action: 'customers.account-deletion.requested-by-admin',
  targetType: ACCOUNT_DELETION_REQUEST_TARGET,
  actors: ['authenticated'],
  after: {
    accountId: auditField.id(),
    waitingPeriodDays: auditField.integer(),
    scheduledFor: auditField.instant(),
    ...STEP_UP_PROOF,
  },
});

/** An admin cancelled a pending request (package 5c); the note is on the request row. */
export const AccountDeletionCancelledByAdmin = defineAuditAction({
  action: 'customers.account-deletion.cancelled-by-admin',
  targetType: ACCOUNT_DELETION_REQUEST_TARGET,
  actors: ['authenticated'],
  after: {
    accountId: auditField.id(),
    ...STEP_UP_PROOF,
  },
});

/** The audit target type of a Customers list export. */
export const CUSTOMERS_EXPORT_TARGET = 'customers.customers-export';

/**
 * An admin exported the Customers list (a bulk copy of personal data), after a fresh two-step
 * code. No search text, no filter value, no address: the file format, how many customers it holds
 * and whether they were picked by id or by the list's filter. The row names the step-up proof.
 */
export const CustomersExported = defineAuditAction({
  action: 'customers.customers.exported',
  targetType: CUSTOMERS_EXPORT_TARGET,
  targetId: auditField.enumOf(['customers-export'] as const),
  actors: ['authenticated'],
  after: {
    format: auditField.enumOf(['csv', 'xlsx'] as const),
    rowCount: auditField.integer(),
    selection: auditField.enumOf(['ids', 'filter'] as const),
    stepUpSessionId: auditField.id(),
    stepUpVerifiedAt: auditField.instant(),
  },
});

/** The audit target type of one customer's page. */
export const CUSTOMER_PAGE_TARGET = 'customers.customer';

/**
 * An admin opened a customer's page (or one tab of it). Target: the customer's account id. The
 * personal data on the page is the reason this is audited; the row holds none of it: only which
 * part was opened.
 */
export const CustomerPageOpened = defineAuditAction({
  action: 'customers.customer-page.opened',
  targetType: CUSTOMER_PAGE_TARGET,
  actors: ['authenticated'],
  after: {
    tab: auditField.enumOf(['overview', 'orders', 'money', 'activity'] as const),
  },
});

/** The audit target type of a saved filter of the Customers list. */
export const CUSTOMERS_SAVED_FILTER_TARGET = 'customers.saved-filter';

/** The lists whose filters can be shared with everyone (see `saved-view-lists.ts`). */
export const SAVED_FILTER_AUDIT_LISTS = ['admin.customers.customers'] as const;
export type SavedFilterAuditList = (typeof SAVED_FILTER_AUDIT_LISTS)[number];
const savedFilterList = auditField.enumOf(SAVED_FILTER_AUDIT_LISTS);
const savedFilterVisibility = auditField.enumOf(['me', 'everyone'] as const);

/** An admin saved a Customers list filter for everyone. The name is not audited: ids and codes only. */
export const SavedFilterSharedAudit = defineAuditAction({
  action: 'customers.saved-filter.shared',
  targetType: CUSTOMERS_SAVED_FILTER_TARGET,
  actors: ['authenticated'],
  after: { listKey: savedFilterList, visibility: savedFilterVisibility },
});

/**
 * An admin changed a filter that is, or was, shared with everyone: renamed it or moved it between
 * "me" and "everyone". `ownedByActor` is false when an admin with the share key changed somebody
 * else's filter.
 */
export const SavedFilterChangedAudit = defineAuditAction({
  action: 'customers.saved-filter.changed',
  targetType: CUSTOMERS_SAVED_FILTER_TARGET,
  actors: ['authenticated'],
  before: { visibility: savedFilterVisibility },
  after: {
    listKey: savedFilterList,
    visibility: savedFilterVisibility,
    renamed: auditField.boolean(),
    ownedByActor: auditField.boolean(),
  },
});

/** An admin deleted a filter that was shared with everyone. */
export const SavedFilterRemovedAudit = defineAuditAction({
  action: 'customers.saved-filter.removed',
  targetType: CUSTOMERS_SAVED_FILTER_TARGET,
  actors: ['authenticated'],
  before: { listKey: savedFilterList, visibility: savedFilterVisibility },
  after: { ownedByActor: auditField.boolean() },
});

/** The audit target type of a manual customer group (phase 2). */
export const CUSTOMER_GROUP_TARGET = 'customers.customer-group';

/** An admin made a manual customer group. The name is a label, not audited: ids and codes only. */
export const CustomerGroupCreated = defineAuditAction({
  action: 'customers.customer-group.created',
  targetType: CUSTOMER_GROUP_TARGET,
  actors: ['authenticated'],
  after: { kind: auditField.enumOf(['manual'] as const), version: auditField.integer() },
});

/** An admin renamed, described, archived or restored a group. What changed, never the text. */
export const CustomerGroupChanged = defineAuditAction({
  action: 'customers.customer-group.changed',
  targetType: CUSTOMER_GROUP_TARGET,
  actors: ['authenticated'],
  before: { version: auditField.integer(), archived: auditField.boolean() },
  after: {
    version: auditField.integer(),
    archived: auditField.boolean(),
    renamed: auditField.boolean(),
    describedChanged: auditField.boolean(),
    /**
     * Phase 2b, on an archive: whether a live promotion's customer-group segment still named the
     * group (`some`, `none`, or `unknown` when promotions could not say); `not-checked` otherwise.
     */
    liveSegmentUse: auditField.enumOf(['not-checked', 'none', 'some', 'unknown'] as const),
  },
});

/**
 * An admin added customers to a group or removed them, one by one or in bulk: how many, and
 * whether they were picked by id or by the Customers list's filter. The account ids are in the
 * customers' timelines, not here.
 */
export const CustomerGroupMembersChanged = defineAuditAction({
  action: 'customers.customer-group.members-changed',
  targetType: CUSTOMER_GROUP_TARGET,
  actors: ['authenticated'],
  after: {
    change: auditField.enumOf(['added', 'removed'] as const),
    count: auditField.integer(),
    selection: auditField.enumOf(['ids', 'filter'] as const),
  },
});

/** An admin wrote an internal note about a customer. Target: the customer; the text is sealed. */
export const CustomerNoteAdded = defineAuditAction({
  action: 'customers.customer-note.added',
  targetType: CUSTOMER_PAGE_TARGET,
  actors: ['authenticated'],
  after: { noteId: auditField.id(), length: auditField.integer() },
});

/** An admin exported a customer's activity timeline, after a fresh two-step code. */
export const CustomerTimelineExported = defineAuditAction({
  action: 'customers.customer-timeline.exported',
  targetType: CUSTOMER_PAGE_TARGET,
  actors: ['authenticated'],
  after: {
    format: auditField.enumOf(['csv', 'xlsx'] as const),
    rowCount: auditField.integer(),
    stepUpSessionId: auditField.id(),
    stepUpVerifiedAt: auditField.instant(),
  },
});

/**
 * An admin revealed one of a customer's full delivery addresses (phase 2b). Target: the customer;
 * the row names the address, never its content.
 */
export const CustomerAddressRevealed = defineAuditAction({
  action: 'customers.customer-address.revealed',
  targetType: CUSTOMER_PAGE_TARGET,
  actors: ['authenticated'],
  after: { addressId: auditField.id() },
});

export const CUSTOMERS_AUDIT_ACTIONS = [
  AccountDeletionSettingsChanged,
  AccountDeletionRequested,
  AccountDeletionCancelled,
  AccountDeletionCompleted,
  AccountDeletionRequestedByAdmin,
  AccountDeletionCancelledByAdmin,
  CustomersExported,
  CustomerPageOpened,
  SavedFilterSharedAudit,
  SavedFilterChangedAudit,
  SavedFilterRemovedAudit,
  CustomerGroupCreated,
  CustomerGroupChanged,
  CustomerGroupMembersChanged,
  CustomerNoteAdded,
  CustomerTimelineExported,
  CustomerAddressRevealed,
] as const;
