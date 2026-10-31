import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';

/**
 * An admin changed the Market's account deletion setting (customers package 5a). Carries the
 * version, the values before and after, and nothing else: no actor (events carry none, ADR-0018
 * decision 4) and no reason text (free text never goes into an event; the reason is in the
 * insert-only history row and the actor in the audit row).
 */
export const AccountDeletionSettingsChangedEvent = defineEvent({
  type: 'customers.account-deletion-settings-changed.v1',
  aggregateType: 'account-deletion-settings',
  payload: {
    previousEnabled: eventField.boolean(),
    enabled: eventField.boolean(),
    previousWaitingPeriodDays: eventField.integer(),
    waitingPeriodDays: eventField.integer(),
  },
});

/** Why a pending deletion request was cancelled. */
export const ACCOUNT_DELETION_CANCEL_REASONS = ['customer', 'sign-in'] as const;
export type AccountDeletionCancelReason = (typeof ACCOUNT_DELETION_CANCEL_REASONS)[number];

// The account deletion request events (customers package 5b). The aggregate is the request: its id
// is the aggregate id, version 1 is the request and version 2 how it ended. No account id, no
// email and no name travels in any of them (the account is meaningless once erased).

/** A buyer asked to delete their account; it will be carried out at `scheduledFor`. */
export const AccountDeletionRequestedEvent = defineEvent({
  type: 'customers.account-deletion-requested.v1',
  aggregateType: 'account-deletion-request',
  payload: {
    waitingPeriodDays: eventField.integer(),
    scheduledFor: eventField.instant(),
  },
});

/** The buyer cancelled the request during the wait, or by signing in. */
export const AccountDeletionCancelledEvent = defineEvent({
  type: 'customers.account-deletion-cancelled.v1',
  aggregateType: 'account-deletion-request',
  payload: {
    reason: eventField.enumOf(ACCOUNT_DELETION_CANCEL_REASONS),
  },
});

/** The account was erased: its key destroyed and its data deleted or forgotten. */
export const AccountDeletionCompletedEvent = defineEvent({
  type: 'customers.account-deletion-completed.v1',
  aggregateType: 'account-deletion-request',
  payload: {
    waitingPeriodDays: eventField.integer(),
  },
});

// Package 5c (admin manual deletion). Same aggregate and the same rules: ids and numbers only. The
// admin, the ticket reference and the reason are free text or identify a person; they stay in the
// request row and the audit row, never in an event.

/** An admin asked for a buyer's account to be deleted; it will be carried out at `scheduledFor`. */
export const AccountDeletionRequestedByAdminEvent = defineEvent({
  type: 'customers.account-deletion-requested-by-admin.v1',
  aggregateType: 'account-deletion-request',
  payload: {
    waitingPeriodDays: eventField.integer(),
    scheduledFor: eventField.instant(),
  },
});

/** An admin cancelled a pending request during the wait. Version 2 of the request aggregate. */
export const AccountDeletionCancelledByAdminEvent = defineEvent({
  type: 'customers.account-deletion-cancelled-by-admin.v1',
  aggregateType: 'account-deletion-request',
  payload: {},
});

export const CUSTOMERS_EVENTS: readonly EventDefinition[] = [
  AccountDeletionSettingsChangedEvent,
  AccountDeletionRequestedEvent,
  AccountDeletionCancelledEvent,
  AccountDeletionCompletedEvent,
  AccountDeletionRequestedByAdminEvent,
  AccountDeletionCancelledByAdminEvent,
];
