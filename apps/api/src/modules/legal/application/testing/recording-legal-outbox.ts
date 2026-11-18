import { encodePayload } from '@mondapac/shared-kernel';
import type { CallContext, PendingEvent } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { LEGAL_EVENTS } from '../../domain/events';

/**
 * Test double of legal's outbox: collects the events with the Market of the call, each checked
 * against its catalogue definition as the real writer does (an unknown type or a payload field
 * that is not declared, such as a consent value, throws).
 */
export class RecordingLegalOutbox implements OutboxWriter {
  readonly events: (PendingEvent & { readonly marketId: string })[] = [];

  append(context: CallContext, events: readonly PendingEvent[]): Promise<void> {
    for (const event of events) {
      const definition = LEGAL_EVENTS.find((known) => known.type === event.type);
      if (definition === undefined) throw new Error(`outbox: unknown type ${event.type}`);
      const checked = encodePayload(definition.fields, event.payload, {
        isKnownPermissionKey: () => false,
      });
      if (!checked.ok) throw new Error(`outbox: ${JSON.stringify(checked.error)}`);
      this.events.push({ ...event, marketId: context.market.marketId });
    }
    return Promise.resolve();
  }
}
