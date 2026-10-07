import type { DomainEvent } from '@mondapac/shared-kernel';
import type { EventBus, RelayTransaction } from '../../events/event-bus';

/**
 * The MVP adapter of ADR-0006 decision 4 (platform persistence design, "P", 6.3 and 6.5). In
 * slice 3 it fans each event out to `platform.event_delivery`, one row per subscriber, through
 * the relay's transaction. Slice 1b has no subscription, so it has nothing to write: an event
 * published before a subscriber exists is not delivered to it later (PA1).
 */
export class InProcessEventBus implements EventBus {
  publish(events: readonly DomainEvent[], transaction: RelayTransaction): Promise<void> {
    void events;
    void transaction;
    // No subscription exists before identity slice 3.
    return Promise.resolve();
  }
}
