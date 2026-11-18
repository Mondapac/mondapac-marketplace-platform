import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';
import { MARKETING_CHANNELS } from './marketing-consent';

// The events legal publishes (customers management phase 2b, part 4). A consent event names the
// account and the channel only: never the value (granted or withdrawn), the source or an address.
// A consumer that needs the value reads legal's facade with its own key. The catalogue snapshot
// (`test/contracts/event-catalogue.snapshot.json`) changes with every type here.
//
// A consent row has no version counter, so each event names its own aggregate: the id of the
// change appended to the history, at version 1. Consumers must not rely on the order between two
// events of one account.

/** A customer's marketing consent on one channel changed (either way). */
export const MarketingConsentChanged = defineEvent({
  type: 'legal.marketing-consent-changed.v1',
  aggregateType: 'marketing-consent-change',
  payload: {
    accountId: eventField.id(),
    channel: eventField.enumOf(MARKETING_CHANNELS),
  },
});

/** Every event legal publishes, registered with the event catalogue by `LegalModule`. */
export const LEGAL_EVENTS: readonly EventDefinition[] = [MarketingConsentChanged];
