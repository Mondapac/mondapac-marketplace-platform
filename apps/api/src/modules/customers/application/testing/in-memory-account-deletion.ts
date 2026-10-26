import { encodePayload } from '@mondapac/shared-kernel';
import type {
  AuditEntry,
  CallContext,
  Id,
  MarketContext,
  PendingEvent,
} from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { AccountDeletionSettingsChanged } from '../../domain/audit';
import { CUSTOMERS_EVENTS } from '../../domain/events';
import type {
  AccountDeletionSettingsRecord,
  AccountDeletionSettingsRepository,
} from '../ports/account-deletion-settings.repository';

// In-memory ports of the account deletion setting for the use-case specs. The setting history is
// kept per Market; the outbox fake checks every payload against its catalogue definition, as the
// real writer does.

export type StoredSettingsRecord = AccountDeletionSettingsRecord & {
  readonly market: string;
  readonly changedBy: string;
  readonly reason: string;
};

export class MemoryAccountDeletionSettings implements AccountDeletionSettingsRepository {
  readonly rows: StoredSettingsRecord[] = [];
  /** Makes the next `append` lose a race: the version is already taken. */
  taken = false;

  latest(market: MarketContext) {
    const mine = this.rows.filter((row) => row.market === market.marketId);
    return Promise.resolve(mine.at(-1) ?? null);
  }

  append(
    market: MarketContext,
    record: AccountDeletionSettingsRecord & {
      readonly changedBy: Id<'Account'>;
      readonly reason: string;
    },
  ) {
    if (this.taken) return Promise.resolve(false);
    this.rows.push({ ...record, market: market.marketId });
    return Promise.resolve(true);
  }
}

export class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (entry.action !== AccountDeletionSettingsChanged.action) {
      throw new Error('audit: unknown action');
    }
    this.entries.push(entry);
    return Promise.resolve();
  }
}

export class RecordingOutbox implements OutboxWriter {
  readonly events: PendingEvent[] = [];
  append(_context: CallContext, events: readonly PendingEvent[]): Promise<void> {
    for (const event of events) {
      const definition = CUSTOMERS_EVENTS.find((d) => d.type === event.type);
      if (definition === undefined) throw new Error(`outbox: unknown type ${event.type}`);
      const checked = encodePayload(definition.fields, event.payload, {
        isKnownPermissionKey: () => false,
      });
      if (!checked.ok) throw new Error(`outbox: ${JSON.stringify(checked.error)}`);
      this.events.push(event);
    }
    return Promise.resolve();
  }
}
