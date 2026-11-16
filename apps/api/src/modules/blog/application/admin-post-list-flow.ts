import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import {
  buildExportFile,
  checkExportSize,
  LIST_EXPORT_MAX_ROWS,
  parseExportColumns,
  parseExportFormat,
  parseExportIds,
  type ExportCell,
  type ExportFile,
  type SheetWriter,
} from '../../../platform/list-export';
import {
  heldKeys,
  MAX_PAGED_ROWS,
  rowActions,
  type PermissionProbe,
  type RowActionRule,
} from '../../../platform/list-query';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import {
  BLOG_POST_EDIT,
  BLOG_POST_PAUSE,
  BLOG_POST_PUBLISH,
  BLOG_POST_REVIEW,
} from '../contracts/permissions';
import {
  POST_EXPORT_COLUMNS,
  POST_LIST_VIEWS,
  POST_SEARCH_MAX,
  POST_SORT_KEYS,
  postViewCounts,
  type PostExportColumn,
  type PostListCursor,
  type PostListFilter,
  type PostListView,
  type PostRowAction,
  type PostSort,
  type PostStatusCounts,
} from '../domain/admin-post-list';
import { OWNER_TYPES, POST_KINDS, type OwnerType, type PostKind } from '../domain/content';
import { refusalFor, type PostAction, type PostStatus } from '../domain/lifecycle';
import { adminOf, summaryView, type PostSummaryView } from './post-support';
import type { AdminPostListReader } from './ports/admin-post-list.reader';
import type { PostListRow } from './ports/blog.repository';

// The admin Blog posts list (super list phase 4, list 26) and its export. A read: nothing here
// changes a post. The row actions only name what the caller may open; each action runs through
// its own use case, which checks its key, the lifecycle and the two-step rules again. No body,
// excerpt or author text is read: ids, the title, the slug, states and times.

type FieldError = { path: string; code: string };

export interface AdminPostListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly list: AdminPostListReader;
  /** One probe per key of {@link POST_ROW_KEYS}: the gate says which ones the caller holds. */
  readonly probes: Readonly<Record<(typeof POST_ROW_KEYS)[number], PermissionProbe>>;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

export const POST_ROW_KEYS = [
  BLOG_POST_EDIT.key,
  BLOG_POST_REVIEW.key,
  BLOG_POST_PUBLISH.key,
  BLOG_POST_PAUSE.key,
] as const;

/** The key each lifecycle action's admin use case checks. */
const ACTION_KEYS: Readonly<Record<PostAction, string>> = {
  edit: BLOG_POST_EDIT.key,
  submit: BLOG_POST_EDIT.key,
  approve: BLOG_POST_REVIEW.key,
  'request-changes': BLOG_POST_REVIEW.key,
  'reviewer-edit': BLOG_POST_REVIEW.key,
  publish: BLOG_POST_PUBLISH.key,
  schedule: BLOG_POST_PUBLISH.key,
  unschedule: BLOG_POST_PUBLISH.key,
  pause: BLOG_POST_PAUSE.key,
  resume: BLOG_POST_PUBLISH.key,
  archive: BLOG_POST_PUBLISH.key,
  'rename-slug': BLOG_POST_PUBLISH.key,
  feature: BLOG_POST_PUBLISH.key,
};

/** An admin's edit and submit reach platform posts only; a seller's post is the seller's. */
const PLATFORM_ONLY: ReadonlySet<PostAction> = new Set(['edit', 'submit']);

const factsOfRow = (row: PostListRow) => ({
  status: row.post.status,
  hasLive: row.post.liveVersionId !== null,
  open: row.openState,
  everPublished: row.post.publishedAt !== null,
  scheduled: row.post.scheduledAt !== null,
});

/** The row Actions menu: Open, then every lifecycle action the post's state and keys allow. */
export const POST_ROW_RULES: readonly RowActionRule<PostListRow>[] = [
  { id: 'open', permission: null },
  ...(Object.keys(ACTION_KEYS) as PostAction[]).map((action) => ({
    id: action,
    permission: ACTION_KEYS[action],
    when: (row: PostListRow) =>
      refusalFor(action, factsOfRow(row)) === null &&
      (!PLATFORM_ONLY.has(action) || row.post.ownerType === 'platform'),
  })),
];

export type AdminPostListFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldError[] };

export const POST_LIST_DEFAULT_PAGE_SIZE = 25;
export const POST_LIST_DEFAULT_LIMIT = 25;
export const POST_LIST_MAX_PAGE_SIZE = 100;
/** Chosen rows one export may name: the same cap as the selection of a page. */
export const POST_EXPORT_MAX_IDS = 200;
/** Posts read per chunk while an export streams. */
const EXPORT_CHUNK = 500;

export interface AdminPostRow extends PostSummaryView {
  readonly actions: readonly PostRowAction[];
}

export interface AdminPostListPage {
  readonly items: readonly AdminPostRow[];
  /** The count of each view for the Market, whatever the filter. */
  readonly counts: Readonly<Record<PostListView, number>>;
  /** Page numbers: the total and the page. Previous/Next: both null. */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  /** A next page exists (both modes; the older panel reads it). */
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

/** A cursor is `<created ms>.<post id>`. */
export const encodePostListCursor = (row: PostListCursor): string =>
  `${row.createdAt.epochMilliseconds}.${row.id}`;

function decodeCursor(value: unknown): PostListCursor | null {
  const match = typeof value === 'string' ? /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value) : null;
  const id = match === null ? null : parseId<'BlogPost'>(match[2]!);
  if (match === null || id === null || !id.ok) return null;
  return { createdAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])), id: id.value };
}

type Paging =
  | { readonly kind: 'pages'; readonly page: number; readonly pageSize: number }
  | { readonly kind: 'prev-next'; readonly after: PostListCursor | null; readonly limit: number };

/** The query of the list: strings as the route receives them; every key is optional. */
type Query = Readonly<Record<string, unknown>>;

const LIST_KEYS = new Set([
  'view',
  'status',
  'kind',
  'owner',
  'sellerId',
  'featured',
  'q',
  'from',
  'to',
  'sort',
  'direction',
  'page',
  'pageSize',
  'cursor',
  'limit',
]);

/** A whole number written as digits, within bounds; null otherwise. */
const whole = (value: unknown, min: number, max: number): number | null => {
  if (typeof value !== 'string' || !/^[0-9]{1,6}$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
};

/** The selector keys (view and filters) shared by the list and the export. */
function parseSelector(q: Query, fields: FieldError[]): PostListFilter {
  const oneOf = <T extends string>(path: string, value: unknown, list: readonly T[]): T | null => {
    if (value === undefined || value === '') return null;
    if (list.includes(value as T)) return value as T;
    fields.push({ path, code: 'value' });
    return null;
  };
  // The older list sends `status` (one status) and no `view`; it is read as the view.
  let view: PostListView = 'all';
  if (q.status !== undefined) {
    if (q.view !== undefined) fields.push({ path: 'status', code: 'with-view' });
    else view = oneOf('status', q.status, POST_LIST_VIEWS) ?? view;
  }
  view = oneOf('view', q.view, POST_LIST_VIEWS) ?? view;
  const kind = oneOf<PostKind>('kind', q.kind, POST_KINDS);
  const ownerType = oneOf<OwnerType>('owner', q.owner, OWNER_TYPES);
  let sellerId: Id<'Seller'> | null = null;
  if (q.sellerId !== undefined && q.sellerId !== '') {
    const parsed =
      typeof q.sellerId === 'string' ? parseId<'Seller'>(q.sellerId.trim().toLowerCase()) : null;
    if (parsed !== null && parsed.ok) sellerId = parsed.value;
    else fields.push({ path: 'sellerId', code: 'format' });
  }
  let featured: boolean | null = null;
  if (q.featured !== undefined && q.featured !== '') {
    if (q.featured === 'true' || q.featured === 'false') featured = q.featured === 'true';
    else fields.push({ path: 'featured', code: 'value' });
  }
  let search: string | null = null;
  if (q.q !== undefined && q.q !== '') {
    // Matched, never echoed or logged.
    const text = typeof q.q === 'string' ? q.q.trim() : null;
    if (text === null || /\p{C}/u.test(text)) fields.push({ path: 'q', code: 'format' });
    else if (Array.from(text).length > POST_SEARCH_MAX) fields.push({ path: 'q', code: 'length' });
    else if (text !== '') search = text;
  }
  const instant = (path: 'from' | 'to', value: unknown): Temporal.Instant | null => {
    if (value === undefined || value === '') return null;
    try {
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
        return Temporal.Instant.from(value);
      }
    } catch {
      // falls through to the refusal below
    }
    fields.push({ path, code: 'format' });
    return null;
  };
  const from = instant('from', q.from);
  const to = instant('to', q.to);
  if (from !== null && to !== null && Temporal.Instant.compare(from, to) >= 0) {
    fields.push({ path: 'to', code: 'range' });
  }
  return {
    status: view === 'all' ? null : view,
    kind,
    ownerType,
    sellerId,
    featured,
    search,
    from,
    to,
  };
}

const NEWEST: PostSort = { key: 'created', direction: 'desc' };

function parseSort(q: Query, fields: FieldError[]): PostSort {
  let key: PostSort['key'] = NEWEST.key;
  if (q.sort !== undefined) {
    if ((POST_SORT_KEYS as readonly unknown[]).includes(q.sort)) key = q.sort as PostSort['key'];
    else fields.push({ path: 'sort', code: 'value' });
  }
  let direction: PostSort['direction'] = 'desc';
  if (q.direction !== undefined) {
    if (q.direction === 'asc' || q.direction === 'desc') direction = q.direction;
    else fields.push({ path: 'direction', code: 'value' });
  }
  return { key, direction };
}

/** Refuses a key outside `allowed` (no value is echoed); false when one was refused. */
function closedQuery(q: unknown, allowed: ReadonlySet<string>, fields: FieldError[]): q is Query {
  if (typeof q !== 'object' || q === null || Array.isArray(q)) {
    fields.push({ path: 'query', code: 'type' });
    return false;
  }
  const unknown = Object.keys(q)
    .filter((key) => !allowed.has(key))
    .sort()
    .slice(0, 10);
  for (const key of unknown) {
    fields.push({
      path: Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�'),
      code: 'unknown-field',
    });
  }
  // A repeated key arrives as an array: one value per key.
  for (const [key, value] of Object.entries(q)) {
    if (allowed.has(key) && typeof value !== 'string') fields.push({ path: key, code: 'type' });
  }
  return fields.length === 0;
}

function parse(
  query: unknown,
): Result<
  { readonly filter: PostListFilter; readonly sort: PostSort; readonly paging: Paging },
  AdminPostListFailure
> {
  const fields: FieldError[] = [];
  const q = query ?? {};
  if (!closedQuery(q, LIST_KEYS, fields)) return err({ code: 'validation.failed', fields });
  const filter = parseSelector(q, fields);
  const prevNext = q.cursor !== undefined || q.limit !== undefined;
  let paging: Paging;
  let sort = NEWEST;
  if (prevNext) {
    for (const path of ['page', 'pageSize', 'sort', 'direction'] as const) {
      if (q[path] !== undefined) fields.push({ path, code: 'with-cursor' });
    }
    let limit = POST_LIST_DEFAULT_LIMIT;
    if (q.limit !== undefined) {
      const given = whole(q.limit, 1, POST_LIST_MAX_PAGE_SIZE);
      if (given === null) fields.push({ path: 'limit', code: 'range' });
      else limit = given;
    }
    let after: PostListCursor | null = null;
    if (q.cursor !== undefined) {
      after = decodeCursor(q.cursor);
      if (after === null) fields.push({ path: 'cursor', code: 'format' });
    }
    paging = { kind: 'prev-next', after, limit };
  } else {
    let page = 1;
    if (q.page !== undefined) {
      const given = whole(q.page, 1, MAX_PAGED_ROWS);
      if (given === null) fields.push({ path: 'page', code: 'range' });
      else page = given;
    }
    let pageSize = POST_LIST_DEFAULT_PAGE_SIZE;
    if (q.pageSize !== undefined) {
      const given = whole(q.pageSize, 1, POST_LIST_MAX_PAGE_SIZE);
      if (given === null) fields.push({ path: 'pageSize', code: 'range' });
      else pageSize = given;
    }
    sort = parseSort(q, fields);
    if (fields.length === 0 && page * pageSize > MAX_PAGED_ROWS) {
      fields.push({ path: 'page', code: 'too-deep' });
    }
    paging = { kind: 'pages', page, pageSize };
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  return ok({ filter, sort, paging });
}

/**
 * The total of a filter that is only a view, read from the status counts; null when the filter
 * narrows further and must be counted.
 */
export function postViewTotal(filter: PostListFilter, counts: PostStatusCounts): number | null {
  const { status, ...rest } = filter;
  if (Object.values(rest).some((value) => value !== null)) return null;
  return postViewCounts(counts)[status ?? 'all'];
}

/**
 * The Market's blog posts for the admin Blog posts list: one page with its total (page numbers)
 * or its next cursor (Previous/Next), the view counts and each row's actions.
 */
export async function listAdminPosts(
  deps: AdminPostListDependencies,
  context: CallContext,
  input: { readonly query?: unknown },
): Promise<Result<AdminPostListPage, AdminPostListFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const parsed = parse(input?.query);
  if (!parsed.ok) return parsed;
  const { filter, sort, paging } = parsed.value;
  const read = await deps.unitOfWork.run<
    {
      readonly rows: readonly PostListRow[];
      readonly total: number | null;
      readonly hasMore: boolean;
      readonly nextCursor: string | null;
      readonly counts: PostStatusCounts;
    },
    AdminPostListFailure
  >(
    context.market,
    async () => {
      const counts = await deps.list.countByStatus(context.market);
      if (paging.kind === 'prev-next') {
        // One row more than asked tells whether a next page exists.
        const found = await deps.list.page(
          context.market,
          filter,
          NEWEST,
          0,
          paging.limit + 1,
          paging.after,
        );
        const rows = found.slice(0, paging.limit);
        const last = rows[rows.length - 1];
        const hasMore = found.length > paging.limit;
        const nextCursor =
          hasMore && last !== undefined
            ? encodePostListCursor({ createdAt: last.post.createdAt, id: last.post.id })
            : null;
        return ok({ rows, total: null, hasMore, nextCursor, counts });
      }
      const rows = await deps.list.page(
        context.market,
        filter,
        sort,
        (paging.page - 1) * paging.pageSize,
        paging.pageSize,
      );
      const total =
        postViewTotal(filter, counts) ?? (await deps.list.count(context.market, filter));
      const hasMore = paging.page * paging.pageSize < total;
      return ok({ rows, total, hasMore, nextCursor: null, counts });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const { rows } = read.value;
  const granted = rows.length === 0 ? new Set<string>() : await heldKeys(context, deps.probes);
  return ok({
    items: rows.map((row) => ({
      ...summaryView(row.post, row.title, row.openState),
      actions: rowActions(row, POST_ROW_RULES, granted) as PostRowAction[],
    })),
    counts: postViewCounts(read.value.counts),
    total: read.value.total,
    page: paging.kind === 'pages' ? paging.page : null,
    pageSize: paging.kind === 'pages' ? paging.pageSize : paging.limit,
    hasMore: read.value.hasMore,
    nextCursor: read.value.nextCursor,
  });
}

// --- the export --------------------------------------------------------------------------------

export type PostExportFailure =
  | AdminPostListFailure
  | { readonly code: 'blog.post-not-found' }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number };

const EXPORT_KEYS = new Set([
  'format',
  'columns',
  'ids',
  'view',
  'status',
  'kind',
  'owner',
  'sellerId',
  'featured',
  'q',
  'from',
  'to',
  'sort',
  'direction',
]);

const HEADERS: Readonly<Record<PostExportColumn | 'base', readonly string[]>> = {
  base: ['Post ID', 'Title', 'Type', 'Author', 'Status', 'Updated (UTC)'],
  slug: ['Slug'],
  'seller-id': ['Seller ID'],
  stage: ['Stage'],
  featured: ['Featured'],
  scheduled: ['Scheduled (UTC)'],
  published: ['Published (UTC)'],
  created: ['Created (UTC)'],
};

/** The panel's words (`blog.posts.kind`, `.state`, `.stage`). */
const KIND_LABELS: Readonly<Record<PostKind, string>> = {
  product: 'Product',
  brand: 'Brand',
  event: 'Event',
  news: 'News',
};
const STATUS_LABELS: Readonly<Record<PostStatus, string>> = {
  draft: 'Draft',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  scheduled: 'Scheduled',
  published: 'Published',
  unpublished: 'Paused',
  archived: 'Archived',
};
const STAGE_LABELS: Readonly<Record<string, string>> = {
  draft: 'Draft',
  in_review: 'In review',
  returned: 'Changes requested',
  approved: 'Approved',
};

const instantText = (value: Temporal.Instant | null) => (value === null ? '' : value.toString());

function cellOf(column: PostExportColumn, row: PostListRow): ExportCell {
  switch (column) {
    case 'slug':
      return row.post.slug;
    case 'seller-id':
      return row.post.sellerId ?? '';
    case 'stage':
      return row.openState === null ? '' : (STAGE_LABELS[row.openState] ?? '');
    case 'featured':
      return row.post.featured ? 'Yes' : 'No';
    case 'scheduled':
      return instantText(row.post.scheduledAt);
    case 'published':
      return instantText(row.post.publishedAt);
    case 'created':
      return row.post.createdAt.toString();
  }
}

/**
 * The posts of the list as a CSV or XLSX file: the chosen `ids` (at most 200; an id that is not a
 * post of the Market refuses the whole file as not found) or what the selector keys match, at
 * most 10,000 (more is `batch.too-large` with the total), in the list's sort. The ids are fixed
 * first in one read; the rows then stream in chunks, each with its own read. Titles are written
 * as text (the CSV writer guards formulas; XLSX cells are strings).
 */
export async function exportAdminPosts(
  deps: AdminPostListDependencies,
  context: CallContext,
  input: { readonly query?: unknown },
): Promise<Result<ExportFile, PostExportFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const fields: FieldError[] = [];
  const q = input?.query ?? {};
  if (!closedQuery(q, EXPORT_KEYS, fields)) return err({ code: 'validation.failed', fields });
  const format = parseExportFormat(q.format);
  if (!format.ok) return format;
  const columns = parseExportColumns(q.columns, POST_EXPORT_COLUMNS);
  if (!columns.ok) return columns;
  const { market } = context;

  let ids: readonly Id<'BlogPost'>[];
  if (q.ids !== undefined && q.ids !== '') {
    const listed = parseExportIds(q.ids as string, POST_EXPORT_MAX_IDS, (part) => {
      const parsed = parseId<'BlogPost'>(part.trim().toLowerCase());
      return parsed.ok ? parsed.value : null;
    });
    if (!listed.ok) return listed;
    const wanted = listed.value;
    const found = await deps.unitOfWork.run<readonly PostListRow[], AdminPostListFailure>(
      market,
      async () => ok(await deps.list.byIds(market, wanted)),
      { readOnly: true },
    );
    if (!found.ok) return found;
    const known = new Set<string>(found.value.map((row) => row.post.id));
    if (wanted.some((id) => !known.has(id))) return err({ code: 'blog.post-not-found' });
    ids = wanted;
  } else {
    const filter = parseSelector(q, fields);
    const sort = parseSort(q, fields);
    if (fields.length > 0) return err({ code: 'validation.failed', fields });
    const picked = await deps.unitOfWork.run<
      { readonly found: readonly Id<'BlogPost'>[]; readonly total: number },
      AdminPostListFailure
    >(
      market,
      async () => {
        const found = await deps.list.idsPage(market, filter, sort, LIST_EXPORT_MAX_ROWS + 1);
        if (found.length <= LIST_EXPORT_MAX_ROWS) return ok({ found, total: found.length });
        return ok({ found, total: await deps.list.count(market, filter) });
      },
      { readOnly: true },
    );
    if (!picked.ok) return picked;
    const size = checkExportSize(picked.value.found.length, picked.value.total);
    if (!size.ok) return size;
    ids = picked.value.found;
  }

  return ok(
    buildExportFile({
      format: format.value,
      baseName: 'blog-posts',
      sheetName: 'Blog posts',
      day: deps.clock.now().toString().slice(0, 10),
      groups: exportRows(deps, context, ids, columns.value),
      sheetWriter: deps.sheetWriter,
    }),
  );
}

async function* exportRows(
  deps: AdminPostListDependencies,
  context: CallContext,
  ids: readonly Id<'BlogPost'>[],
  columns: readonly PostExportColumn[],
): AsyncGenerator<readonly (readonly ExportCell[])[]> {
  yield [[...HEADERS.base, ...columns.flatMap((column) => HEADERS[column])]];
  for (let start = 0; start < ids.length; start += EXPORT_CHUNK) {
    const chunk = ids.slice(start, start + EXPORT_CHUNK);
    const read = await deps.unitOfWork.run<readonly PostListRow[], AdminPostListFailure>(
      context.market,
      async () => ok(await deps.list.byIds(context.market, chunk)),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('blog.posts-export: the read failed');
    // In the order the ids were fixed (the list's sort), whatever order the read answers.
    const byId = new Map<string, PostListRow>(read.value.map((row) => [row.post.id, row]));
    const rows = chunk.flatMap((id) => {
      const row = byId.get(id);
      return row === undefined ? [] : [row];
    });
    yield rows.map((row) => [
      row.post.id,
      row.title,
      KIND_LABELS[row.post.kind],
      row.post.ownerType === 'platform' ? 'Platform' : 'Seller',
      STATUS_LABELS[row.post.status],
      row.post.updatedAt.toString(),
      ...columns.map((column) => cellOf(column, row)),
    ]);
  }
}
