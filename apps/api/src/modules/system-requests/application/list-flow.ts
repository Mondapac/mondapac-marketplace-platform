import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { isReviewArea, isRisk, type ReviewArea, type Risk } from '../domain/areas';
import {
  numberFromSearch,
  REQUEST_STATUSES,
  REQUEST_VIEWS,
  type RequestTab,
  type RequestStatus,
  type SystemRequest,
  type Viewer,
} from '../domain/request';
import {
  REQUEST_SORTS,
  type Direction,
  type Keyset,
  type PageWindow,
  type RequestFilter,
  type RequestSort,
} from './ports/request.repository';
import {
  approveInUnit,
  decidable,
  MAX_BULK,
  requestView,
  reviewableAreas,
  signedInAdmin,
  supersedingNumbers,
  withLabels,
  type FieldIssue,
  type RequestView,
  type SystemRequestsFailure,
} from './request-flow';
import type { SystemRequestsDependencies } from './system-requests-dependencies';

export { REQUEST_VIEWS, type RequestTab };

const logger = new Logger('SystemRequestsList');

// The System requests list (a super list, CLAUDE.md rule 14): views, search, filters, sort, page
// numbers with a total or Previous and Next (the panel picks the mode from the Market's List
// paging setting: `page` asks for page numbers, no `page` for a cursor), the count of every view
// for the same search and filters, and each row's actions for the caller. Saved filters, the
// column choice and the export come from the shared super list kit (phase 0) and are not here.

/** Page numbers stop at this row (the List paging design); beyond it the panel uses the cursor. */
export const MAX_PAGED_ROWS = 10_000;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
const MAX_SEARCH = 100;

export interface ListInput {
  readonly view?: unknown;
  readonly q?: unknown;
  readonly area?: unknown;
  readonly risk?: unknown;
  readonly status?: unknown;
  readonly requestedBy?: unknown;
  readonly decidedBy?: unknown;
  readonly appliedFrom?: unknown;
  readonly appliedTo?: unknown;
  readonly overdue?: unknown;
  readonly subjectKind?: unknown;
  readonly subjectRef?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  readonly page?: unknown;
  readonly pageSize?: unknown;
  readonly cursor?: unknown;
}

export interface RequestListView {
  readonly rows: readonly RequestView[];
  /** Every view's count for the same search and filters (at most 10,000 each). */
  readonly counts: Readonly<Record<RequestTab, number>>;
  /** Page mode: the rows that match (at most 10,000); null in cursor mode. */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  /** Cursor mode: the cursor of the next page, or null on the last one. */
  readonly nextCursor: string | null;
}

/** The caller's area review keys as a `Viewer`, and the list query's own badge count. */
export interface BadgeView {
  readonly needsMyReview: number;
  readonly overdue: number;
}

const csv = (value: unknown): string[] | null | undefined => {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 400) return null;
  return value.split(',').map((part) => part.trim());
};

function listOf<T extends string>(
  value: unknown,
  check: (item: unknown) => item is T,
  path: string,
  fields: FieldIssue[],
): T[] | undefined {
  const parts = csv(value);
  if (parts === undefined) return undefined;
  if (parts === null || parts.length === 0 || !parts.every(check)) {
    fields.push({ path, code: 'value' });
    return undefined;
  }
  return [...new Set(parts)] as T[];
}

const isStatus = (value: unknown): value is RequestStatus =>
  typeof value === 'string' && (REQUEST_STATUSES as readonly string[]).includes(value);

function accountOf(value: unknown, path: string, fields: FieldIssue[]): Id<'Account'> | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = typeof value === 'string' ? parseId(value) : null;
  if (parsed === null || !parsed.ok) {
    fields.push({ path, code: 'format' });
    return undefined;
  }
  return parsed.value as Id<'Account'>;
}

function instantOf(
  value: unknown,
  path: string,
  fields: FieldIssue[],
): Temporal.Instant | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'string' && value.length <= 40) {
    try {
      return Temporal.Instant.from(value);
    } catch {
      // Falls through to the refusal.
    }
  }
  fields.push({ path, code: 'format' });
  return undefined;
}

function wholeOf(
  value: unknown,
  min: number,
  max: number,
  path: string,
  fields: FieldIssue[],
): number | undefined {
  if (value === undefined || value === '') return undefined;
  const number = typeof value === 'string' && /^[0-9]{1,6}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    fields.push({ path, code: 'range' });
    return undefined;
  }
  return number;
}

/** Intersects two narrowing lists; undefined means "no narrowing". */
function both<T>(
  a: readonly T[] | undefined,
  b: readonly T[] | undefined,
): readonly T[] | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a.filter((item) => b.includes(item));
}

/**
 * The filter of one view combined with the user's filter, or null when the two cannot both hold
 * (the view then counts and lists nothing, without a query).
 */
export function viewFilter(
  view: RequestTab,
  base: RequestFilter,
  viewer: Viewer,
  now: Temporal.Instant,
): RequestFilter | null {
  let filter: RequestFilter = base;
  switch (view) {
    case 'needs-my-review':
      filter = {
        ...base,
        statuses: both(base.statuses, ['open']),
        areas: both(base.areas, [...viewer.reviews]),
        notRequestedBy: viewer.accountId,
      };
      if (base.requestedBy === viewer.accountId) return null;
      break;
    case 'all-open':
      filter = { ...base, statuses: both(base.statuses, ['open']) };
      break;
    case 'mine':
      if (base.requestedBy !== undefined && base.requestedBy !== viewer.accountId) return null;
      filter = { ...base, requestedBy: viewer.accountId };
      break;
    case 'approved':
      filter = { ...base, statuses: both(base.statuses, ['approved']) };
      break;
    case 'reverted':
      filter = { ...base, statuses: both(base.statuses, ['reverted']) };
      break;
    case 'overdue':
      filter = {
        ...base,
        statuses: both(base.statuses, ['open']),
        dueBy:
          base.dueBy === undefined || base.dueBy.epochMilliseconds > now.epochMilliseconds
            ? now
            : base.dueBy,
      };
      break;
    case 'all':
      break;
  }
  if (filter.statuses?.length === 0 || filter.areas?.length === 0 || filter.risks?.length === 0) {
    return null;
  }
  return filter;
}

interface CursorBody {
  readonly s: RequestSort;
  readonly d: Direction;
  readonly v: string | number;
  readonly n: number;
}

export function encodeCursor(sort: RequestSort, direction: Direction, last: SystemRequest): string {
  const value =
    sort === 'number'
      ? last.number
      : (sort === 'due' ? last.reviewDueAt : last.appliedAt).toString();
  const body: CursorBody = { s: sort, d: direction, v: value, n: last.number };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, sort: RequestSort, direction: Direction): Keyset | null {
  if (cursor.length > 200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  try {
    const body = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<CursorBody>;
    if (body.s !== sort || body.d !== direction) return null;
    if (!Number.isSafeInteger(body.n) || (body.n as number) < 1) return null;
    if (sort === 'number') {
      return Number.isSafeInteger(body.v)
        ? { value: body.v as number, number: body.n as number }
        : null;
    }
    if (typeof body.v !== 'string') return null;
    return { value: Temporal.Instant.from(body.v), number: body.n as number };
  } catch {
    return null;
  }
}

interface ParsedQuery {
  readonly view: RequestTab;
  readonly filter: RequestFilter;
  readonly sort: RequestSort;
  readonly direction: Direction;
  readonly page: number | null;
  readonly pageSize: number;
  readonly after: Keyset | null;
}

function parseQuery(input: ListInput): Result<ParsedQuery, SystemRequestsFailure> {
  const fields: FieldIssue[] = [];
  const view = input?.view === undefined || input.view === '' ? 'all-open' : input.view;
  if (!(REQUEST_VIEWS as readonly unknown[]).includes(view))
    fields.push({ path: 'view', code: 'value' });

  let number: number | undefined;
  let text: string | undefined;
  if (input?.q !== undefined && input.q !== '') {
    if (typeof input.q !== 'string' || Array.from(input.q).length > MAX_SEARCH) {
      fields.push({ path: 'q', code: 'length' });
    } else if (input.q.trim() !== '') {
      const asNumber = numberFromSearch(input.q);
      if (asNumber !== null) number = asNumber;
      else text = input.q.trim();
    }
  }
  const areas = listOf<ReviewArea>(input?.area, isReviewArea, 'area', fields);
  const risks = listOf<Risk>(input?.risk, isRisk, 'risk', fields);
  const statuses = listOf<RequestStatus>(input?.status, isStatus, 'status', fields);
  const requestedBy = accountOf(input?.requestedBy, 'requestedBy', fields);
  const decidedBy = accountOf(input?.decidedBy, 'decidedBy', fields);
  const appliedFrom = instantOf(input?.appliedFrom, 'appliedFrom', fields);
  const appliedBefore = instantOf(input?.appliedTo, 'appliedTo', fields);
  let overdue = false;
  if (input?.overdue !== undefined && input.overdue !== '') {
    if (input.overdue === 'true') overdue = true;
    else if (input.overdue !== 'false') fields.push({ path: 'overdue', code: 'value' });
  }
  let subjectKind: string | undefined;
  if (input?.subjectKind !== undefined && input.subjectKind !== '') {
    if (typeof input.subjectKind === 'string' && input.subjectKind.length <= 96) {
      subjectKind = input.subjectKind;
    } else fields.push({ path: 'subjectKind', code: 'format' });
  }
  let subjectRef: string | undefined;
  if (input?.subjectRef !== undefined && input.subjectRef !== '') {
    if (typeof input.subjectRef === 'string' && input.subjectRef.length <= 128) {
      subjectRef = input.subjectRef;
    } else fields.push({ path: 'subjectRef', code: 'format' });
  }

  const sort = input?.sort === undefined || input.sort === '' ? 'applied' : input.sort;
  if (!(REQUEST_SORTS as readonly unknown[]).includes(sort))
    fields.push({ path: 'sort', code: 'value' });
  const direction =
    input?.direction === undefined || input.direction === '' ? 'asc' : input.direction;
  if (direction !== 'asc' && direction !== 'desc')
    fields.push({ path: 'direction', code: 'value' });
  const page = wholeOf(input?.page, 1, MAX_PAGED_ROWS, 'page', fields);
  const pageSize =
    wholeOf(input?.pageSize, 1, MAX_PAGE_SIZE, 'pageSize', fields) ?? DEFAULT_PAGE_SIZE;
  if (page !== undefined && (page - 1) * pageSize >= MAX_PAGED_ROWS) {
    fields.push({ path: 'page', code: 'range' });
  }
  let after: Keyset | null = null;
  if (input?.cursor !== undefined && input.cursor !== '') {
    if (page !== undefined) fields.push({ path: 'cursor', code: 'with-page' });
    else if (
      typeof input.cursor !== 'string' ||
      (REQUEST_SORTS as readonly unknown[]).includes(sort) === false ||
      (direction !== 'asc' && direction !== 'desc')
    ) {
      fields.push({ path: 'cursor', code: 'format' });
    } else {
      after = decodeCursor(input.cursor, sort as RequestSort, direction);
      if (after === null) fields.push({ path: 'cursor', code: 'format' });
    }
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });

  const filter: RequestFilter = {
    ...(areas === undefined ? {} : { areas }),
    ...(risks === undefined ? {} : { risks }),
    ...(statuses === undefined ? {} : { statuses }),
    ...(requestedBy === undefined ? {} : { requestedBy }),
    ...(decidedBy === undefined ? {} : { decidedBy }),
    ...(appliedFrom === undefined ? {} : { appliedFrom }),
    ...(appliedBefore === undefined ? {} : { appliedBefore }),
    ...(subjectKind === undefined ? {} : { subjectKind }),
    ...(subjectRef === undefined ? {} : { subjectRef }),
    ...(number === undefined ? {} : { number }),
    ...(text === undefined ? {} : { text }),
  };
  return ok({
    view: view as RequestTab,
    filter: overdue
      ? { ...filter, statuses: both(filter.statuses, ['open']), dueBy: FAR_FUTURE }
      : filter,
    sort: sort as RequestSort,
    direction: direction as Direction,
    page: page ?? null,
    pageSize,
    after,
  });
}

/**
 * A placeholder for "overdue as of now" in the user's filter: replaced by the current instant in
 * {@link viewFilter} (the earlier of the two wins), so `overdue=true` and the Overdue view agree.
 */
const FAR_FUTURE = Temporal.Instant.from('9999-12-31T00:00:00Z');

const resolveNow = (filter: RequestFilter, now: Temporal.Instant): RequestFilter =>
  filter.dueBy !== undefined && filter.dueBy.epochMilliseconds > now.epochMilliseconds
    ? { ...filter, dueBy: now }
    : filter;

/** `ListSystemRequests`: one page of a view, every view's count, and the rows' actions. */
export async function listRequests(
  deps: SystemRequestsDependencies,
  context: CallContext,
  input: ListInput,
): Promise<Result<RequestListView, SystemRequestsFailure>> {
  const admin = signedInAdmin(context);
  if (admin === null) return err({ code: 'access.denied' });
  const parsed = parseQuery(input);
  if (!parsed.ok) return parsed;
  const query = parsed.value;
  const viewer: Viewer = { accountId: admin, reviews: await reviewableAreas(deps, context) };
  const now = deps.clock.now();
  const base = resolveNow(query.filter, now);
  const read = await deps.unitOfWork.run<RequestListView, SystemRequestsFailure>(
    context.market,
    async () => {
      const counts = {} as Record<RequestTab, number>;
      for (const view of REQUEST_VIEWS) {
        const filter = viewFilter(view, base, viewer, now);
        counts[view] =
          filter === null ? 0 : await deps.requests.count(context.market, filter, MAX_PAGED_ROWS);
      }
      const filter = viewFilter(query.view, base, viewer, now);
      const window: PageWindow =
        query.page === null
          ? { kind: 'keyset', after: query.after, limit: query.pageSize + 1 }
          : { kind: 'offset', offset: (query.page - 1) * query.pageSize, limit: query.pageSize };
      const found =
        filter === null
          ? []
          : await deps.requests.page(context.market, filter, query.sort, query.direction, window);
      const rows = query.page === null ? found.slice(0, query.pageSize) : found;
      const more = query.page === null && found.length > query.pageSize;
      const numbers = await supersedingNumbers(deps, context, rows);
      return ok({
        rows: rows.map((row) => requestView(row, viewer, now, numbers)),
        counts,
        total: query.page === null ? null : counts[query.view],
        page: query.page,
        pageSize: query.pageSize,
        nextCursor:
          more && rows.length > 0
            ? encodeCursor(query.sort, query.direction, rows[rows.length - 1]!)
            : null,
      });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  // Names and subject labels come from other modules' facades, after the unit (P 3.1 row 5).
  const { views } = await withLabels(deps, context, read.value.rows);
  return ok({ ...read.value, rows: views });
}

/** The filter fields of the list that "select all matching" takes (no paging, no sort). */
export const MATCHING_FIELDS = [
  'view',
  'q',
  'area',
  'risk',
  'status',
  'requestedBy',
  'decidedBy',
  'appliedFrom',
  'appliedTo',
  'overdue',
  'subjectKind',
  'subjectRef',
] as const;

export type MatchingInput = { readonly [K in (typeof MATCHING_FIELDS)[number]]?: unknown };

export interface MatchingOutcome {
  /** Approved in this call, oldest SR number first. */
  readonly approved: readonly { readonly id: Id<'SystemRequest'>; readonly number: number }[];
  /** Refused in this call (decided by someone else in between, for example), with the code. */
  readonly failed: readonly {
    readonly id: Id<'SystemRequest'>;
    readonly code: SystemRequestsFailure['code'];
  }[];
  /**
   * How many approvable requests still match after this call (at most 10,000); null when the
   * count could not be read after the approvals committed (the panel then stops).
   */
  readonly remaining: number | null;
}

/**
 * What "select all matching" may approve among the rows of `view`: open, low risk, in an area
 * the caller reviews, not the caller's own. Null when nothing can match.
 */
function approvableFilter(
  view: RequestTab,
  base: RequestFilter,
  viewer: Viewer,
  now: Temporal.Instant,
): RequestFilter | null {
  const filter = viewFilter(view, base, viewer, now);
  if (filter === null || filter.requestedBy === viewer.accountId) return null;
  const narrowed: RequestFilter = {
    ...filter,
    statuses: both(filter.statuses, ['open']),
    risks: both(filter.risks, ['low']),
    areas: both(filter.areas, [...viewer.reviews]),
    // A proposal is applied when approved, so it is approved one by one, never in bulk.
    modes: ['review'],
    notRequestedBy: viewer.accountId,
  };
  if (
    narrowed.statuses?.length === 0 ||
    narrowed.risks?.length === 0 ||
    narrowed.areas?.length === 0
  ) {
    return null;
  }
  return narrowed;
}

/**
 * `ApproveMatchingSystemRequests` (CLAUDE.md rule 14, "select all matching"): bulk approve of
 * every request that matches the list's view, search and filters and that the caller may approve
 * in bulk (open, low risk, an area they review, not their own). At most 100 per call, oldest SR
 * number first, each in its own unit as `ApproveSystemRequests` does (same checks, same audit);
 * the answer says how many still match, so the panel calls again while `remaining` is above 0
 * and the last call approved at least one.
 */
export async function approveMatching(
  deps: SystemRequestsDependencies,
  context: CallContext,
  input: MatchingInput,
): Promise<Result<MatchingOutcome, SystemRequestsFailure>> {
  const admin = signedInAdmin(context);
  if (admin === null) return err({ code: 'access.denied' });
  // Only the filter fields: paging and sort are not part of "what matches".
  const only: Record<string, unknown> = {};
  for (const field of MATCHING_FIELDS) {
    if (input?.[field] !== undefined) only[field] = input[field];
  }
  const parsed = parseQuery(only);
  if (!parsed.ok) return parsed;
  const query = parsed.value;
  const areas = await reviewableAreas(deps, context);
  const viewer: Viewer = { accountId: admin, reviews: areas };
  const now = deps.clock.now();
  const filter = approvableFilter(query.view, resolveNow(query.filter, now), viewer, now);
  if (filter === null) return ok({ approved: [], failed: [], remaining: 0 });

  const candidates = await deps.unitOfWork.run<readonly SystemRequest[], SystemRequestsFailure>(
    context.market,
    async () =>
      ok(
        await deps.requests.page(context.market, filter, 'number', 'asc', {
          kind: 'offset',
          offset: 0,
          limit: MAX_BULK,
        }),
      ),
    { readOnly: true },
  );
  if (!candidates.ok) return candidates;
  const approved: { id: Id<'SystemRequest'>; number: number }[] = [];
  const failed: { id: Id<'SystemRequest'>; code: SystemRequestsFailure['code'] }[] = [];
  for (const candidate of candidates.value) {
    const result = await deps.unitOfWork.run<SystemRequest, SystemRequestsFailure>(
      context.market,
      async () => {
        const found = await decidable(deps, context, 'approve', admin, candidate.id);
        if (!found.ok) return found;
        if (found.value.risk !== 'low') return err({ code: 'system-requests.not-low-risk' });
        if (found.value.mode !== 'review') return err({ code: 'system-requests.one-by-one' });
        if (!areas.has(found.value.area)) return err({ code: 'system-requests.not-reviewer' });
        return ok(await approveInUnit(deps, context, admin, found.value, null));
      },
    );
    if (result.ok) approved.push({ id: candidate.id, number: candidate.number });
    else failed.push({ id: candidate.id, code: result.error.code });
  }
  // The approvals have committed: a failed count never turns them into an error.
  let remaining: number | null = null;
  try {
    const counted = await deps.unitOfWork.run<number, SystemRequestsFailure>(
      context.market,
      async () => ok(await deps.requests.count(context.market, filter, MAX_PAGED_ROWS)),
      { readOnly: true },
    );
    if (counted.ok) remaining = counted.value;
  } catch (error) {
    logger.warn({
      msg: 'system-requests.matching-remaining-unavailable',
      error: error instanceof Error ? error.name : 'unknown',
      approved: approved.length,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
  return ok({ approved, failed, remaining });
}

/** `CountSystemRequests`: the menu badge (Needs my review) and the Overdue count. */
export async function badgeCounts(
  deps: SystemRequestsDependencies,
  context: CallContext,
): Promise<Result<BadgeView, SystemRequestsFailure>> {
  const admin = signedInAdmin(context);
  if (admin === null) return err({ code: 'access.denied' });
  const viewer: Viewer = { accountId: admin, reviews: await reviewableAreas(deps, context) };
  const now = deps.clock.now();
  return deps.unitOfWork.run<BadgeView, SystemRequestsFailure>(
    context.market,
    async () => {
      const mine = viewFilter('needs-my-review', {}, viewer, now);
      const overdue = viewFilter('overdue', {}, viewer, now);
      return ok({
        needsMyReview:
          mine === null ? 0 : await deps.requests.count(context.market, mine, MAX_PAGED_ROWS),
        overdue:
          overdue === null ? 0 : await deps.requests.count(context.market, overdue, MAX_PAGED_ROWS),
      });
    },
    { readOnly: true },
  );
}
