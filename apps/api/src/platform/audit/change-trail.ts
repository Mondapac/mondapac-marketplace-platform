import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../unit-of-work/unit-of-work';
import type { AuditTrailReader, AuditTrailRow } from './audit-trail-reader';

// "Last changed by {name} . {time}" and the history of one settings page, read from the module's
// own audit rows (docs/design/domain/platform-audit.md 10; settings last-changed design in each
// owning module's design doc). Platform code: it knows no module. A module binds one
// {@link ChangeTrail} on its own audit reader and its own {@link ChangeActorSource}.

/**
 * Who made a change, as the viewer may see it.
 *
 * - `member`: a person of the viewer's own side: an admin for an admin viewer, a current member of
 *   the shop's team for a seller viewer. `byDisplayName` is their display name, or null when they
 *   cannot be named any more (a former member, a removed account).
 * - `platform`: Mondapac staff, seen by a seller. The name is never given (PA 10, Hassan I4).
 * - `system`: a job or the platform itself.
 */
export type ChangeByKind = 'member' | 'platform' | 'system';

/** The latest change of a settings page. */
export interface LastChanged {
  readonly at: Temporal.Instant;
  readonly byDisplayName: string | null;
  readonly byKind: ChangeByKind;
}

/** One change of the history list: when, who, and the names of the fields that changed. */
export interface ChangeHistoryItem extends LastChanged {
  /** The audit row's id, also the cursor of the next page. */
  readonly id: string;
  /** Field names only (never a value). Empty when the row does not say which. */
  readonly fields: readonly string[];
}

export interface ChangeHistoryPage {
  /** Newest first. */
  readonly items: readonly ChangeHistoryItem[];
  /** The `after` of the next page, or null when this page was the last. */
  readonly next: string | null;
}

/** What identity says about one account the viewer may see named. PERSONAL DATA: never logged. */
export interface ChangeActorLabel {
  readonly kind: 'member' | 'platform';
  readonly displayName: string | null;
}

/**
 * Names the accounts of audit rows for the viewer in `context`, outside any unit of work. An id
 * that is absent could not be named (a former member, another side). Implemented over identity's
 * facade; throws when identity cannot answer, so the caller never shows a guess.
 */
export interface ChangeActorSource {
  labelsOf(
    context: CallContext,
    accountIds: readonly string[],
  ): Promise<ReadonlyMap<string, ChangeActorLabel>>;
}

/** Which audit rows are one settings page's changes. */
export interface ChangeScope {
  /** Actions of the module's own catalogue. */
  readonly actions: readonly string[];
  /** The page's target, or null for a page of the whole Market (see `AuditTrailScope`). */
  readonly targetId: string | null;
  /** The field names a row of an action names when its sides do not (e.g. only versions). */
  readonly fixedFields?: Readonly<Record<string, readonly string[]>>;
  /** Side keys that are not settings fields (versions, proofs). `version` is always ignored. */
  readonly ignoreKeys?: readonly string[];
  /**
   * Names the fields of a row from its sides, when neither a fixed list nor the keys that differ
   * say it (e.g. the kind of an image). Names only, no value. Takes precedence over both.
   */
  readonly fieldsOf?: (row: AuditTrailRow) => readonly string[];
}

export interface ChangeHistoryInput {
  readonly after?: unknown;
  readonly limit?: unknown;
}

export type ChangeHistoryFailure = {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
};

/** The page size when the request names none, and the largest it may name. */
export const CHANGE_HISTORY_PAGE = 20;
export const MAX_CHANGE_HISTORY_PAGE = 50;

/** At most this many field names per change, each one a plain identifier. */
const MAX_FIELDS = 32;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const objectOf = (side: unknown): Readonly<Record<string, unknown>> =>
  typeof side === 'object' && side !== null && !Array.isArray(side)
    ? (side as Readonly<Record<string, unknown>>)
    : {};

/**
 * The names of the keys whose value differs between the two sides of an audit row (a missing side
 * is empty), without `version` and `ignore`. Names only: no value leaves this function.
 */
export function changedFields(
  before: unknown,
  after: unknown,
  ignore: readonly string[] = [],
): string[] {
  const left = objectOf(before);
  const right = objectOf(after);
  const skipped = new Set(['version', ...ignore]);
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...names]
    .filter(
      (name) => !skipped.has(name) && FIELD_NAME.test(name) && !sameJson(left[name], right[name]),
    )
    .sort()
    .slice(0, MAX_FIELDS);
}

/** The fields of one history row: the action's fixed names, else the keys that changed. */
export function fieldsOfRow(row: AuditTrailRow, scope: ChangeScope): readonly string[] {
  if (scope.fieldsOf !== undefined) return scope.fieldsOf(row).slice(0, MAX_FIELDS);
  const fixed = scope.fixedFields?.[row.action];
  if (fixed !== undefined) return fixed;
  return changedFields(row.before, row.after, scope.ignoreKeys);
}

/** Who made a row, given the labels identity answered. */
function whoOf(
  row: AuditTrailRow,
  labels: ReadonlyMap<string, ChangeActorLabel>,
): { byDisplayName: string | null; byKind: ChangeByKind } {
  if (row.actorType !== 'USER' || row.actorId === null) {
    return { byDisplayName: null, byKind: 'system' };
  }
  const label = labels.get(row.actorId);
  if (label === undefined) return { byDisplayName: null, byKind: 'member' };
  return { byDisplayName: label.displayName, byKind: label.kind };
}

const userIdsOf = (rows: readonly AuditTrailRow[]): string[] => [
  ...new Set(
    rows.flatMap((row) => (row.actorType === 'USER' && row.actorId !== null ? [row.actorId] : [])),
  ),
];

/**
 * Reads the changes of one settings page. Bound per module (it holds the module's own reader, so
 * it reads only that module's own audit actions), used by the module's use cases, outside any
 * open unit. The audit rows hold ids and codes only; the names come from {@link ChangeActorSource}
 * after the unit is closed.
 */
export class ChangeTrail {
  readonly #logger = new Logger('ChangeTrail');

  constructor(
    private readonly deps: {
      readonly unitOfWork: UnitOfWork;
      readonly reader: AuditTrailReader;
      readonly actors: ChangeActorSource;
    },
  ) {}

  /**
   * The newest change of the page, or null when there is none (never changed) or when it cannot
   * be read: a settings page still opens without its "last changed" line. The log line carries
   * the outcome and error name, never a name.
   */
  async lastChanged(context: CallContext, scope: ChangeScope): Promise<LastChanged | null> {
    try {
      const rows = await this.rowsOf(context, scope, null, 1);
      if (rows === null || rows.length === 0) return null;
      const labels = await this.labelsOf(context, rows);
      return { at: rows[0]!.occurredAt, ...whoOf(rows[0]!, labels) };
    } catch (error) {
      this.#logger.error({
        msg: 'change-trail.last-changed.failed',
        error: error instanceof Error ? error.name : 'unknown',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return null;
    }
  }

  /**
   * A flow's result with the winning save named on a version conflict: when `result` is an error
   * whose code is one of `conflictCodes`, the error gains `lastChanged` (the page's newest
   * change, which is the save that won); any other result is returned unchanged.
   */
  async namingTheWinner<T, E extends { readonly code: string }>(
    context: CallContext,
    scope: ChangeScope,
    result: Result<T, E>,
    conflictCodes: readonly string[],
  ): Promise<Result<T, E>> {
    if (result.ok || !conflictCodes.includes(result.error.code)) return result;
    const lastChanged = await this.lastChanged(context, scope);
    return err({ ...result.error, lastChanged });
  }

  /** One page of the history, newest first. Throws when the audit or identity cannot answer. */
  async history(
    context: CallContext,
    scope: ChangeScope,
    input: ChangeHistoryInput,
  ): Promise<Result<ChangeHistoryPage, ChangeHistoryFailure>> {
    const invalid = (path: string, code: string): Result<never, ChangeHistoryFailure> =>
      err({ code: 'validation.failed', fields: [{ path, code }] });
    const limit = input.limit ?? CHANGE_HISTORY_PAGE;
    if (
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_CHANGE_HISTORY_PAGE
    ) {
      return invalid('limit', 'range');
    }
    let after: string | null = null;
    if (input.after !== undefined && input.after !== null) {
      const parsed = typeof input.after === 'string' ? parseId(input.after) : null;
      if (parsed === null || !parsed.ok) return invalid('after', 'format');
      after = parsed.value;
    }
    // One row more than the page tells whether another page exists.
    const rows = await this.rowsOf(context, scope, after, limit + 1);
    if (rows === null) return invalid('after', 'unknown');
    const page = rows.slice(0, limit);
    const labels = await this.labelsOf(context, page);
    return ok({
      items: page.map((row) => ({
        id: row.id,
        at: row.occurredAt,
        ...whoOf(row, labels),
        fields: fieldsOfRow(row, scope),
      })),
      next: rows.length > limit ? page[page.length - 1]!.id : null,
    });
  }

  /** The rows in one read-only unit; null when the cursor names no row of this history. */
  private async rowsOf(
    context: CallContext,
    scope: ChangeScope,
    after: string | null,
    limit: number,
  ): Promise<readonly AuditTrailRow[] | null> {
    const read = await this.deps.unitOfWork.run<readonly AuditTrailRow[] | null, never>(
      context.market,
      async () => {
        const history = await this.deps.reader.historyOf(context.market, {
          actions: scope.actions,
          targetId: scope.targetId,
          after,
          limit,
        });
        return ok(history.ok ? history.value : null);
      },
      { readOnly: true },
    );
    return read.ok ? read.value : null;
  }

  private async labelsOf(
    context: CallContext,
    rows: readonly AuditTrailRow[],
  ): Promise<ReadonlyMap<string, ChangeActorLabel>> {
    const ids = userIdsOf(rows);
    return ids.length === 0 ? new Map() : this.deps.actors.labelsOf(context, ids);
  }
}

/** Nest token of a module's own {@link ChangeTrail}; never exported by the module. */
export const CHANGE_TRAIL = Symbol('CHANGE_TRAIL');
/** Nest token of the module's {@link ChangeActorSource}. */
export const CHANGE_ACTOR_SOURCE = Symbol('CHANGE_ACTOR_SOURCE');

/** The HTTP shape of {@link LastChanged}: an ISO instant, a name or null, a kind. */
export interface LastChangedBody {
  readonly at: string;
  readonly byDisplayName: string | null;
  readonly byKind: ChangeByKind;
}

export const lastChangedBody = (value: LastChanged | null): LastChangedBody | null =>
  value === null
    ? null
    : { at: value.at.toString(), byDisplayName: value.byDisplayName, byKind: value.byKind };

export interface ChangeHistoryBody {
  readonly items: readonly (LastChangedBody & {
    readonly id: string;
    readonly fields: readonly string[];
  })[];
  readonly next: string | null;
}

export const changeHistoryBody = (page: ChangeHistoryPage): ChangeHistoryBody => ({
  items: page.items.map((item) => ({
    id: item.id,
    at: item.at.toString(),
    byDisplayName: item.byDisplayName,
    byKind: item.byKind,
    fields: item.fields,
  })),
  next: page.next,
});

/**
 * The query of a history route as the trail takes it: a digits-only `limit` becomes a number,
 * anything else is passed on as `'invalid'` for the trail to refuse.
 */
export function changeHistoryInputOf(query: Record<string, unknown>): ChangeHistoryInput {
  const { after, limit } = query;
  return {
    after: after ?? null,
    limit:
      limit === undefined
        ? undefined
        : typeof limit === 'string' && /^[0-9]{1,3}$/.test(limit)
          ? Number(limit)
          : 'invalid',
  };
}

/**
 * The `details` of a version conflict (409): the winning save, as `lastChanged` (null when the
 * trail could not say). Undefined when the refusal carries no such field.
 */
export function conflictDetails(error: Record<string, unknown>): object | undefined {
  if (error.lastChanged === undefined) return undefined;
  return { lastChanged: lastChangedBody(error.lastChanged as LastChanged | null) };
}
