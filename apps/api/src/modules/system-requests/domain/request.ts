import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { ReviewArea, Risk } from './areas';

// A system request (the review of a change that is already live) and its rules: the shape of the
// values kept before and after, the note and reason texts, when a request is overdue, and which
// actions a viewer has on it. Pure: no I/O.

export const REQUEST_STATUSES = ['open', 'approved', 'reverted'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** approved; rejected (a reviewer reverted it); withdrawn (the author reverted it). */
export const DECISIONS = ['approved', 'rejected', 'withdrawn'] as const;
export type Decision = (typeof DECISIONS)[number];

export const ACTIVITY_KINDS = [
  'applied',
  'commented',
  'approved',
  'rejected',
  'withdrawn',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * What a viewer may do with a row, so the panel's row menu matches the server: open and
 * copy-link always; approve and reject for a reviewer of the area who is not the author; withdraw
 * for the author. Reject and withdraw need the change to be the subject's latest.
 */
export const REQUEST_ACTIONS = ['open', 'copy-link', 'approve', 'reject', 'withdraw'] as const;
export type RequestAction = (typeof REQUEST_ACTIONS)[number];

/** A JSON value as kept before and after a change. */
export type ChangeValue =
  | string
  | number
  | boolean
  | null
  | readonly ChangeValue[]
  | { readonly [field: string]: ChangeValue };

/** The values of a change: a flat or nested object, at most 10 KB as JSON. */
export type ChangeValues = { readonly [field: string]: ChangeValue };

/**
 * 10 KB as compact JSON: the table allows 16 KB of jsonb text, which adds a space after every
 * colon and comma (at most one per two bytes of compact JSON with the limits below: 10 KB grows
 * to under 16 KB), and text holds no control character (jsonb would escape it to six bytes).
 */
export const MAX_VALUES_BYTES = 10_240;
const MAX_FIELDS = 50;
const MAX_LIST = 100;
const MAX_DEPTH = 3;
const MAX_TEXT = 500;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function valueOk(value: unknown, depth: number): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return Array.from(value).length <= MAX_TEXT && !hasControl(value);
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return (
      depth < MAX_DEPTH && value.length <= MAX_LIST && value.every((v) => valueOk(v, depth + 1))
    );
  }
  if (typeof value === 'object') {
    // A plain object (a literal or JSON.parse's); not a class instance, a Date or a Map.
    const maker = (value as { readonly constructor?: unknown }).constructor;
    if (depth >= MAX_DEPTH || (maker !== Object && maker !== undefined)) return false;
    const entries = Object.entries(value);
    return (
      entries.length <= MAX_FIELDS &&
      entries.every(([name, inner]) => FIELD_NAME.test(name) && valueOk(inner, depth + 1))
    );
  }
  return false;
}

/**
 * Whether `value` can be kept as the values of a change: a plain object whose fields are named
 * `[A-Za-z][A-Za-z0-9_-]*`, holding text (500 characters at most), finite numbers, booleans,
 * null, lists (100 at most) and objects, three levels deep at most, 10 KB as JSON at most; text
 * holds no control character. A
 * module passes its own value shape; money goes as minor units in text, never as a float.
 */
export function isChangeValues(value: unknown): value is ChangeValues {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (!valueOk(value, 0)) return false;
  return new TextEncoder().encode(JSON.stringify(value)).length <= MAX_VALUES_BYTES;
}

/** Two value objects say the same thing (field order does not matter). */
export function sameValues(a: ChangeValue, b: ChangeValue): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const other: readonly ChangeValue[] = b;
    return a.every((item: ChangeValue, index) => sameValues(item, other[index]!));
  }
  const left = a as ChangeValues;
  const right = b as ChangeValues;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && sameValues(left[key]!, right[key]!));
}

/** Kind and key of a subject: `<module>.<subject>` and the item's own key. */
export const SUBJECT_KIND = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
export const SUBJECT_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
export const isSubjectKind = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 96 && SUBJECT_KIND.test(value);
export const isSubjectRef = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 128 && SUBJECT_REF.test(value);

export type TextCheck =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: 'required' | 'type' | 'length' };

/** A control character other than a line break (U+000A). */
function hasControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code < 0x20 && code !== 0x0a) || code === 0x7f) return true;
  }
  return false;
}

/**
 * A free text the admin wrote (a note, a reason, a comment): trimmed, at least one character and
 * at most `max` characters; control characters other than a line break are refused.
 */
export function checkText(value: unknown, max: number): TextCheck {
  if (value === undefined || value === null) return { ok: false, code: 'required' };
  if (typeof value !== 'string') return { ok: false, code: 'type' };
  const text = value.trim();
  if (text.length === 0) return { ok: false, code: 'required' };
  if (hasControl(text)) return { ok: false, code: 'type' };
  if (Array.from(text).length > max) return { ok: false, code: 'length' };
  return { ok: true, text };
}

export const MAX_NOTE = 500;
export const MAX_REASON = 500;
export const MAX_COMMENT = 2000;

/** The tabs of the System requests list (the views bar). */
export const REQUEST_VIEWS = [
  'needs-my-review',
  'all-open',
  'mine',
  'approved',
  'reverted',
  'overdue',
  'all',
] as const;
export type RequestTab = (typeof REQUEST_VIEWS)[number];

/** One request as the module keeps it. */
export interface SystemRequest {
  readonly id: Id<'SystemRequest'>;
  readonly number: number;
  readonly area: ReviewArea;
  readonly subjectKind: string;
  readonly subjectRef: string;
  readonly risk: Risk;
  readonly status: RequestStatus;
  readonly before: ChangeValues;
  readonly after: ChangeValues;
  readonly note: string;
  readonly requestedBy: Id<'Account'>;
  readonly appliedAt: Temporal.Instant;
  readonly reviewDueAt: Temporal.Instant;
  readonly decision: Decision | null;
  readonly decidedBy: Id<'Account'> | null;
  readonly decidedAt: Temporal.Instant | null;
  readonly decisionReason: string | null;
  readonly supersededBy: Id<'SystemRequest'> | null;
  readonly commentCount: number;
}

/** An open request past its review date. A decided one is never overdue. */
export const isOverdue = (
  request: Pick<SystemRequest, 'status' | 'reviewDueAt'>,
  now: Temporal.Instant,
): boolean =>
  request.status === 'open' && request.reviewDueAt.epochMilliseconds <= now.epochMilliseconds;

export interface Viewer {
  readonly accountId: Id<'Account'>;
  /** The areas whose review key the viewer holds. */
  readonly reviews: ReadonlySet<ReviewArea>;
}

/** The actions `viewer` has on `request` (see {@link REQUEST_ACTIONS}). */
export function actionsFor(
  request: Pick<SystemRequest, 'status' | 'area' | 'requestedBy' | 'supersededBy'>,
  viewer: Viewer,
): RequestAction[] {
  const actions: RequestAction[] = ['open', 'copy-link'];
  if (request.status !== 'open') return actions;
  const own = request.requestedBy === viewer.accountId;
  const latest = request.supersededBy === null;
  if (!own && viewer.reviews.has(request.area)) {
    actions.push('approve');
    if (latest) actions.push('reject');
  }
  if (own && latest) actions.push('withdraw');
  return actions;
}

/** The SR number as admins see it. */
export const displayNumber = (number: number): string => `SR-${number}`;

/** `SR-1042`, `sr-1042` or `1042` names request number 1042; anything else is not a number. */
export function numberFromSearch(text: string): number | null {
  const match = /^(?:sr-?)?([0-9]{1,9})$/i.exec(text.trim());
  if (match === null) return null;
  const number = Number(match[1]);
  return number >= 1 && number <= 2_147_483_647 ? number : null;
}
