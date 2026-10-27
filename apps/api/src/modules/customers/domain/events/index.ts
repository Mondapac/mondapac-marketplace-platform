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

export const CUSTOMERS_EVENTS: readonly EventDefinition[] = [AccountDeletionSettingsChangedEvent];
