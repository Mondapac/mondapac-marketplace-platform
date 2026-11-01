import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, MarketContext } from '@mondapac/shared-kernel';
import type { Clock } from '@mondapac/shared-kernel';
import type { AuditTrailReader, AuditTrailRow } from '../../src/platform/audit/audit-trail-reader';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import {
  ChangeTrail,
  type ChangeActorLabel,
  type ChangeActorSource,
} from '../../src/platform/audit/change-trail';
import type { UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';

// In-memory stand-ins for the audit log and identity's names, so a module's use-case spec runs
// the real ChangeTrail ("last changed by" and history) without a database. The audit reader on
// PostgreSQL is covered by test/db/audit-trail-history.db-spec.ts.

interface Stored extends AuditTrailRow {
  readonly marketId: string;
}

/**
 * One object that is the module's audit writer and its audit reader: every entry recorded in a
 * use case comes back, newest first, with the actor of its call context and the clock's time.
 */
export class InMemoryAuditTrail implements AuditWriter, AuditTrailReader {
  readonly rows: Stored[] = [];
  /** The entries as the use cases built them, in order. */
  readonly entries: AuditEntry[] = [];
  #seq = 0;

  constructor(private readonly clock: Pick<Clock, 'now'>) {}

  record(context: CallContext, entry: AuditEntry): Promise<void> {
    this.#seq += 1;
    this.entries.push(entry);
    const actor = context.actor;
    this.rows.push({
      id: `01990000-0000-7000-8000-${this.#seq.toString(16).padStart(12, '0')}`,
      marketId: context.market.marketId,
      occurredAt: this.clock.now(),
      actorType: actor.kind === 'authenticated' ? 'USER' : 'SYSTEM',
      actorId: actor.kind === 'authenticated' ? actor.accountId : null,
      action: entry.action,
      targetId: entry.targetId,
      before: entry.before ?? null,
      after: entry.after ?? null,
    });
    return Promise.resolve();
  }

  history(
    market: MarketContext,
    query: { action: string; targetId: string; after: string | null; limit: number },
  ) {
    return this.historyOf(market, {
      actions: [query.action],
      targetId: query.targetId,
      after: query.after,
      limit: query.limit,
    });
  }

  historyOf(
    market: MarketContext,
    scope: {
      actions: readonly string[];
      targetId: string | null;
      after: string | null;
      limit: number;
    },
  ) {
    const newest = this.rows
      .filter(
        (row) =>
          row.marketId === market.marketId &&
          scope.actions.includes(row.action) &&
          (scope.targetId === null || row.targetId === scope.targetId),
      )
      .reverse();
    let from = 0;
    if (scope.after !== null) {
      const at = newest.findIndex((row) => row.id === scope.after);
      if (at < 0) return Promise.resolve(err({ code: 'cursor.unknown' as const }));
      from = at + 1;
    }
    return Promise.resolve(ok<readonly AuditTrailRow[]>(newest.slice(from, from + scope.limit)));
  }
}

/** Names by account id, as identity would answer for the viewer; absent ids are unnamed. */
export class FakeChangeActors implements ChangeActorSource {
  readonly labels = new Map<string, ChangeActorLabel>();
  readonly calls: (readonly string[])[] = [];
  failure: Error | null = null;

  labelsOf(_context: CallContext, accountIds: readonly string[]) {
    this.calls.push(accountIds);
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(
      new Map(
        accountIds.flatMap((id) => (this.labels.has(id) ? [[id, this.labels.get(id)!]] : [])),
      ),
    );
  }
}

/** A real {@link ChangeTrail} over the in-memory audit and names. */
export function changeTrailOf(
  unitOfWork: UnitOfWork,
  audit: InMemoryAuditTrail,
  actors: ChangeActorSource,
): ChangeTrail {
  return new ChangeTrail({ unitOfWork, reader: audit, actors });
}

export const at = (iso: string) => Temporal.Instant.from(iso);

/** A trail for a spec of a use case that never reads "last changed" (it would throw if called). */
export const unusedChangeTrail = new ChangeTrail({
  unitOfWork: undefined as never,
  reader: undefined as never,
  actors: undefined as never,
});
