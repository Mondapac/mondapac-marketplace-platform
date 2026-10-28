import { encodePayload, ok, Temporal } from '@mondapac/shared-kernel';
import type {
  AuditEntry,
  CallContext,
  Id,
  MarketContext,
  PendingEvent,
  Result,
} from '@mondapac/shared-kernel';
import type {
  ConsumedStepUp,
  StepUpProofConsumer,
  StepUpRefusal,
} from '../../../../platform/authz';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { CUSTOMERS_AUDIT_ACTIONS } from '../../domain/audit';
import { CUSTOMERS_EVENTS } from '../../domain/events';
import type { AccountDeletionRequest } from '../../domain/account-deletion-request';
import type { AccountDeletionRequestRepository } from '../ports/account-deletion-request.repository';
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
    if (!CUSTOMERS_AUDIT_ACTIONS.some((definition) => definition.action === entry.action)) {
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

/**
 * identity's spend of the admin step-up proof: a fresh proof of the caller's session unless a test
 * sets `answer` to a refusal. Records every action key it was asked to spend.
 */
export class RecordingStepUp implements StepUpProofConsumer {
  readonly asked: string[] = [];
  answer: Result<ConsumedStepUp, StepUpRefusal> | null = null;

  constructor(
    private readonly verifiedAt: Temporal.Instant = Temporal.Instant.from('2026-10-26T09:58:00Z'),
  ) {}

  consume(context: CallContext, actionKey: string): Promise<Result<ConsumedStepUp, StepUpRefusal>> {
    this.asked.push(actionKey);
    if (this.answer !== null) return Promise.resolve(this.answer);
    const sessionId = (context.actor as { readonly sessionId: Id<'Session'> }).sessionId;
    return Promise.resolve(ok({ sessionId, verifiedAt: this.verifiedAt }));
  }
}

export type StoredDeletionRequest = AccountDeletionRequest & {
  readonly market: string;
  readonly closedAt: Temporal.Instant | null;
  readonly cancelReason: 'customer' | 'sign-in' | null;
};

/**
 * The request store in memory, with the partial unique index (one open request per account and
 * Market) and every transition as a conditional update, as the database does it.
 */
export class MemoryAccountDeletionRequests implements AccountDeletionRequestRepository {
  readonly rows = new Map<string, StoredDeletionRequest>();
  /** Runs once, just before the next `claim` or `cancel` is applied: lets a test interleave. */
  beforeNextTransition: (() => void) | null = null;

  private interleave() {
    const hook = this.beforeNextTransition;
    this.beforeNextTransition = null;
    hook?.();
  }

  private isOpen(row: StoredDeletionRequest) {
    return row.status === 'pending' || row.status === 'executing';
  }

  insertPending(market: MarketContext, request: AccountDeletionRequest) {
    const taken = [...this.rows.values()].some(
      (row) =>
        row.market === market.marketId && row.accountId === request.accountId && this.isOpen(row),
    );
    if (taken) return Promise.resolve(false);
    this.rows.set(request.id, {
      ...request,
      status: 'pending',
      claimedAt: null,
      market: market.marketId,
      closedAt: null,
      cancelReason: null,
    });
    return Promise.resolve(true);
  }

  findActiveOf(market: MarketContext, accountId: Id<'Account'>) {
    const row = [...this.rows.values()].find(
      (r) => r.market === market.marketId && r.accountId === accountId && this.isOpen(r),
    );
    return Promise.resolve(row ?? null);
  }

  cancel(
    market: MarketContext,
    id: Id<'AccountDeletionRequest'>,
    reason: 'customer' | 'sign-in',
    at: Temporal.Instant,
  ) {
    this.interleave();
    const row = this.rows.get(id);
    if (row === undefined || row.market !== market.marketId || row.status !== 'pending') {
      return Promise.resolve(false);
    }
    this.rows.set(id, { ...row, status: 'cancelled', closedAt: at, cancelReason: reason });
    return Promise.resolve(true);
  }

  claim(
    market: MarketContext,
    id: Id<'AccountDeletionRequest'>,
    at: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ) {
    this.interleave();
    const row = this.rows.get(id);
    if (row === undefined || row.market !== market.marketId) return Promise.resolve(false);
    const duePending =
      row.status === 'pending' && Temporal.Instant.compare(row.scheduledFor, at) <= 0;
    const staleExecuting =
      row.status === 'executing' &&
      row.claimedAt !== null &&
      Temporal.Instant.compare(row.claimedAt, staleBefore) <= 0;
    if (!duePending && !staleExecuting) return Promise.resolve(false);
    this.rows.set(id, { ...row, status: 'executing', claimedAt: at });
    return Promise.resolve(true);
  }

  release(market: MarketContext, id: Id<'AccountDeletionRequest'>, claimedAt: Temporal.Instant) {
    const row = this.rows.get(id);
    if (
      row === undefined ||
      row.market !== market.marketId ||
      row.status !== 'executing' ||
      row.claimedAt === null ||
      Temporal.Instant.compare(row.claimedAt, claimedAt) !== 0
    ) {
      return Promise.resolve(false);
    }
    this.rows.set(id, { ...row, status: 'pending', claimedAt: null });
    return Promise.resolve(true);
  }

  complete(
    market: MarketContext,
    id: Id<'AccountDeletionRequest'>,
    claimedAt: Temporal.Instant,
    at: Temporal.Instant,
  ) {
    const row = this.rows.get(id);
    if (
      row === undefined ||
      row.market !== market.marketId ||
      row.status !== 'executing' ||
      row.claimedAt === null ||
      Temporal.Instant.compare(row.claimedAt, claimedAt) !== 0
    ) {
      return Promise.resolve(false);
    }
    this.rows.set(id, { ...row, status: 'completed', closedAt: at });
    return Promise.resolve(true);
  }

  listDue(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
    limit: number,
  ) {
    const mine = [...this.rows.values()].filter((r) => r.market === market.marketId);
    const stale = mine
      .filter(
        (r) =>
          r.status === 'executing' &&
          r.claimedAt !== null &&
          Temporal.Instant.compare(r.claimedAt, staleBefore) <= 0,
      )
      .sort((a, b) => Temporal.Instant.compare(a.claimedAt!, b.claimedAt!));
    const pending = mine
      .filter((r) => r.status === 'pending' && Temporal.Instant.compare(r.scheduledFor, now) <= 0)
      .sort((a, b) => Temporal.Instant.compare(a.scheduledFor, b.scheduledFor));
    return Promise.resolve([...stale, ...pending].slice(0, limit));
  }
}
