import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { ReviewArea, Risk } from '../../domain/areas';
import type { ActivityKind, Decision, RequestStatus, SystemRequest } from '../../domain/request';

/** One line of a request's history. */
export interface ActivityRecord {
  readonly id: Id<'SystemRequestActivity'>;
  readonly kind: ActivityKind;
  readonly actor: Id<'Account'>;
  readonly at: Temporal.Instant;
  readonly body: string | null;
}

/**
 * Which requests a list or a count covers. Every field narrows; an empty list matches nothing
 * (so "the areas I review" with no area gives no row).
 */
export interface RequestFilter {
  readonly statuses?: readonly RequestStatus[];
  readonly areas?: readonly ReviewArea[];
  readonly risks?: readonly Risk[];
  readonly requestedBy?: Id<'Account'>;
  readonly notRequestedBy?: Id<'Account'>;
  readonly decidedBy?: Id<'Account'>;
  readonly appliedFrom?: Temporal.Instant;
  /** Exclusive. */
  readonly appliedBefore?: Temporal.Instant;
  /** Open and due at or before this instant (the overdue requests). */
  readonly dueBy?: Temporal.Instant;
  readonly subjectKind?: string;
  readonly subjectRef?: string;
  /** Exactly this SR number. */
  readonly number?: number;
  /** A part of the note, the subject kind or the subject key, case-insensitive. */
  readonly text?: string;
}

export const REQUEST_SORTS = ['applied', 'due', 'number'] as const;
export type RequestSort = (typeof REQUEST_SORTS)[number];
export type Direction = 'asc' | 'desc';

/** Where a cursor page starts: after the row with this sort value and number. */
export interface Keyset {
  /** The sort column's value of the last row: an instant (applied, due) or the number. */
  readonly value: Temporal.Instant | number;
  readonly number: number;
}

export type PageWindow =
  | { readonly kind: 'offset'; readonly offset: number; readonly limit: number }
  | { readonly kind: 'keyset'; readonly after: Keyset | null; readonly limit: number };

export interface NewRequest {
  readonly id: Id<'SystemRequest'>;
  readonly area: ReviewArea;
  readonly subjectKind: string;
  readonly subjectRef: string;
  readonly risk: Risk;
  readonly before: SystemRequest['before'];
  readonly after: SystemRequest['after'];
  readonly note: string;
  readonly requestedBy: Id<'Account'>;
  readonly appliedAt: Temporal.Instant;
  readonly reviewDueAt: Temporal.Instant;
}

export interface DecisionWrite {
  readonly status: Exclude<RequestStatus, 'open'>;
  readonly decision: Decision;
  readonly decidedBy: Id<'Account'>;
  readonly decidedAt: Temporal.Instant;
  readonly reason: string | null;
}

/**
 * `system_requests.requests`, its activity and the per-Market counter, scoped by the Market.
 * Every method runs in the open unit of the use case (or of the module that records a change).
 */
export interface RequestRepository {
  /**
   * Opens a request: takes the Market's next SR number (the counter row's lock orders two
   * openings), inserts the request and its `applied` activity, and marks the subject's earlier
   * requests that are not yet superseded as superseded by it. Returns the number and the ids it
   * superseded.
   */
  open(
    market: MarketContext,
    request: NewRequest,
    activityId: Id<'SystemRequestActivity'>,
  ): Promise<{ readonly number: number; readonly superseded: readonly Id<'SystemRequest'>[] }>;
  find(market: MarketContext, id: Id<'SystemRequest'>): Promise<SystemRequest | null>;
  /** As `find`, with the row locked for the rest of the unit. */
  findForUpdate(market: MarketContext, id: Id<'SystemRequest'>): Promise<SystemRequest | null>;
  /** Several by id, in no order; ids of another Market are absent. */
  findMany(
    market: MarketContext,
    ids: readonly Id<'SystemRequest'>[],
  ): Promise<readonly SystemRequest[]>;
  /** Writes the decision of an open request; false when it was not open any more. */
  decide(market: MarketContext, id: Id<'SystemRequest'>, decision: DecisionWrite): Promise<boolean>;
  addActivity(
    market: MarketContext,
    requestId: Id<'SystemRequest'>,
    activity: ActivityRecord,
  ): Promise<void>;
  /** Adds a comment and returns the request's new comment count. */
  addComment(
    market: MarketContext,
    requestId: Id<'SystemRequest'>,
    activity: ActivityRecord,
  ): Promise<number>;
  activity(market: MarketContext, id: Id<'SystemRequest'>): Promise<readonly ActivityRecord[]>;
  page(
    market: MarketContext,
    filter: RequestFilter,
    sort: RequestSort,
    direction: Direction,
    window: PageWindow,
  ): Promise<readonly SystemRequest[]>;
  /** How many rows match, counting at most `cap` (a larger answer is `cap`). */
  count(market: MarketContext, filter: RequestFilter, cap: number): Promise<number>;
}

export const REQUEST_REPOSITORY = Symbol('SYSTEM_REQUESTS_REQUEST_REPOSITORY');
