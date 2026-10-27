import type { CallContext } from '@mondapac/shared-kernel';
import type { SecurityEventInput } from '../../src/platform/security-events/security-event-catalogue';
import type { SecurityEvents } from '../../src/platform/security-events/security-events';

/**
 * A security event recorder without a database: it keeps what it is given, with the actor kind
 * and Market (test/db/security-events.db-spec.ts covers the real recorder).
 */
export class RecordingSecurityEvents implements SecurityEvents {
  readonly events: (SecurityEventInput & { readonly actor: string; readonly marketId: string })[] =
    [];

  record(context: CallContext, event: SecurityEventInput): Promise<void> {
    this.events.push({ ...event, actor: context.actor.kind, marketId: context.market.marketId });
    return Promise.resolve();
  }
}
