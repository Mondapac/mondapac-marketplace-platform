import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import { LOSS_BEARERS, LOSS_REASON_CODES } from './reason-codes';
import { REFUND_REASONS } from './refund';

// The audited actions of refunds (tax step 3; Hassan M3), registered at boot with
// `registerAuditActions('ordering', ORDERING_AUDIT_ACTIONS)`. Ids, codes, counts and money only:
// never a Stripe id, a card detail or a customer's name.

/** The audit target type of a refund; the target id is the refund id. */
export const REFUND_TARGET = 'ordering.refund';

/** An admin asked for a refund: it is written, with the refunded sum raised, before Stripe. */
export const RefundRequested = defineAuditAction({
  action: 'ordering.refund.requested',
  targetType: REFUND_TARGET,
  actors: ['authenticated'],
  after: {
    sellerOrderId: auditField.id(),
    amount: auditField.money(),
    /** Null when the refund reverses no tax (a zero rate). */
    tax: auditField.optional(auditField.money()),
    reason: auditField.enumOf(REFUND_REASONS),
    /** Who bears the loss: the seller (reversed in its ledger) or the platform (nothing posted). */
    lossBearer: auditField.enumOf(LOSS_BEARERS),
    /** Null for a seller-borne refund; the closed-list code when the platform bears it. */
    lossReasonCode: auditField.optional(auditField.enumOf(LOSS_REASON_CODES)),
    lineCount: auditField.integer(),
  },
});

/** Stripe's answer settled the refund: succeeded with its credit note, or failed. */
export const RefundSettled = defineAuditAction({
  action: 'ordering.refund.settled',
  targetType: REFUND_TARGET,
  actors: ['authenticated', 'system'],
  after: {
    outcome: auditField.enumOf(['succeeded', 'failed'] as const),
    creditNoteId: auditField.optional(auditField.id()),
  },
});

/** The audit target type of a saved filter of an order list. */
export const ORDERING_SAVED_FILTER_TARGET = 'ordering.saved-filter';

const savedFilterVisibility = auditField.enumOf(['me', 'everyone'] as const);

/** The lists whose filters can be shared with everyone (the admin ones, see `saved-view-lists.ts`). */
export const SAVED_FILTER_AUDIT_LISTS = ['admin.ordering.orders'] as const;
export type SavedFilterAuditList = (typeof SAVED_FILTER_AUDIT_LISTS)[number];
const savedFilterList = auditField.enumOf(SAVED_FILTER_AUDIT_LISTS);

/** An admin saved an order filter for everyone. The name is not audited: ids and codes only. */
export const SavedFilterSharedAudit = defineAuditAction({
  action: 'ordering.saved-filter.shared',
  targetType: ORDERING_SAVED_FILTER_TARGET,
  actors: ['authenticated'],
  after: { listKey: savedFilterList, visibility: savedFilterVisibility },
});

/**
 * An admin changed an order filter that is, or was, shared with everyone: renamed it or moved it
 * between "me" and "everyone". `ownedByActor` is false when an admin with the share key changed
 * somebody else's filter.
 */
export const SavedFilterChangedAudit = defineAuditAction({
  action: 'ordering.saved-filter.changed',
  targetType: ORDERING_SAVED_FILTER_TARGET,
  actors: ['authenticated'],
  before: { visibility: savedFilterVisibility },
  after: {
    listKey: savedFilterList,
    visibility: savedFilterVisibility,
    renamed: auditField.boolean(),
    ownedByActor: auditField.boolean(),
  },
});

/** An admin deleted an order filter that was shared with everyone. */
export const SavedFilterRemovedAudit = defineAuditAction({
  action: 'ordering.saved-filter.removed',
  targetType: ORDERING_SAVED_FILTER_TARGET,
  actors: ['authenticated'],
  before: { listKey: savedFilterList, visibility: savedFilterVisibility },
  after: { ownedByActor: auditField.boolean() },
});

export const ORDERING_AUDIT_ACTIONS = [
  RefundRequested,
  RefundSettled,
  SavedFilterSharedAudit,
  SavedFilterChangedAudit,
  SavedFilterRemovedAudit,
] as const;
