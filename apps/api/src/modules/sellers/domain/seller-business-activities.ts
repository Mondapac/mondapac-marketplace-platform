import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';

// The business activities a seller carries (ADR-0040 decision 4): one MAIN activity and up to nine
// extras, replaced as a whole by an admin with a reason. The activities are owned by `catalog`; the
// ids here are plain ids that the use case checks through catalog's contract.

/** The most extra activities beside the main one. */
export const MAX_EXTRA_ACTIVITIES = 9;
/** The longest reason of a direct admin change. */
export const ACTIVITY_CHANGE_REASON_MAX = 300;

export interface ActivityAssignment {
  readonly mainActivityId: Id<'BusinessActivity'>;
  /** Distinct, not the main one, in ascending order so equal sets compare equal. */
  readonly extraActivityIds: readonly Id<'BusinessActivity'>[];
}

/** What a seller carries now: no main activity until an admin assigns one. */
export interface StoredActivityAssignment {
  readonly mainActivityId: Id<'BusinessActivity'> | null;
  readonly extraActivityIds: readonly Id<'BusinessActivity'>[];
}

export interface ActivityFieldProblem {
  readonly path: string;
  readonly code: string;
}

export interface ActivityChangeRequest {
  readonly assignment: ActivityAssignment;
  readonly reason: string;
}

const BODY_KEYS = ['mainActivityId', 'extraActivityIds', 'reason'] as const;
/** Control, format and separator characters other than a plain space: never part of a reason. */
const HIDDEN_OR_CONTROL = /[\p{C}\p{Zl}\p{Zp}]/u;

/** Whether two assignments name the same main and the same extras. */
export function sameAssignment(a: StoredActivityAssignment, b: StoredActivityAssignment): boolean {
  return (
    a.mainActivityId === b.mainActivityId &&
    a.extraActivityIds.length === b.extraActivityIds.length &&
    a.extraActivityIds.every((id, index) => id === b.extraActivityIds[index])
  );
}

/** Every activity id of an assignment, the main one first. */
export function allActivityIds(a: StoredActivityAssignment): Id<'BusinessActivity'>[] {
  return a.mainActivityId === null
    ? [...a.extraActivityIds]
    : [a.mainActivityId, ...a.extraActivityIds];
}

/**
 * Reads the body of "replace the assignment": a closed object with exactly one main activity,
 * 0 to 9 distinct extras that do not repeat the main one, and a reason of 1 to 300 characters
 * (trimmed). Codes and field paths only; no value is echoed. Pure: the activities' existence is
 * the use case's check.
 */
export function parseActivityChange(
  body: unknown,
): Result<ActivityChangeRequest, readonly ActivityFieldProblem[]> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return err([{ path: '', code: 'type' }]);
  }
  const fields: ActivityFieldProblem[] = [];
  for (const key of Object.keys(body).sort()) {
    if (!(BODY_KEYS as readonly string[]).includes(key)) {
      fields.push({ path: key.slice(0, 64), code: 'unknown-field' });
    }
  }
  const { mainActivityId, extraActivityIds, reason } = body as Record<string, unknown>;

  let main: Id<'BusinessActivity'> | null = null;
  if (mainActivityId === undefined || mainActivityId === null) {
    fields.push({ path: 'mainActivityId', code: 'required' });
  } else {
    const parsed =
      typeof mainActivityId === 'string' ? parseId<'BusinessActivity'>(mainActivityId) : null;
    if (parsed === null || !parsed.ok) fields.push({ path: 'mainActivityId', code: 'format' });
    else main = parsed.value;
  }

  const extras = new Set<Id<'BusinessActivity'>>();
  if (extraActivityIds === undefined) {
    fields.push({ path: 'extraActivityIds', code: 'required' });
  } else if (!Array.isArray(extraActivityIds)) {
    fields.push({ path: 'extraActivityIds', code: 'type' });
  } else if (extraActivityIds.length > MAX_EXTRA_ACTIVITIES) {
    fields.push({ path: 'extraActivityIds', code: 'length' });
  } else {
    for (const [index, value] of (extraActivityIds as unknown[]).entries()) {
      const parsed = typeof value === 'string' ? parseId<'BusinessActivity'>(value) : null;
      if (parsed === null || !parsed.ok) {
        fields.push({ path: `extraActivityIds.${index}`, code: 'format' });
      } else if (parsed.value === main || extras.has(parsed.value)) {
        fields.push({ path: `extraActivityIds.${index}`, code: 'duplicate' });
      } else {
        extras.add(parsed.value);
      }
    }
  }

  let text = '';
  if (reason === undefined || reason === null) {
    fields.push({ path: 'reason', code: 'required' });
  } else if (typeof reason !== 'string') {
    fields.push({ path: 'reason', code: 'type' });
  } else {
    text = reason.trim();
    if (text.length === 0) fields.push({ path: 'reason', code: 'required' });
    else if ([...text].length > ACTIVITY_CHANGE_REASON_MAX)
      fields.push({ path: 'reason', code: 'length' });
    else if (HIDDEN_OR_CONTROL.test(text.replace(/ /g, '')))
      fields.push({ path: 'reason', code: 'characters' });
  }

  if (fields.length > 0 || main === null) return err(fields);
  return ok({
    assignment: { mainActivityId: main, extraActivityIds: [...extras].sort() },
    reason: text,
  });
}
