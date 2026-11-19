import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  buildExportFile,
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
  listPage,
  listQueryInvalid,
  pageWindow,
  parseListQuery,
  rowActions,
  MAX_PAGED_ROWS,
  type ListPage,
  type ListQuery,
  type ListQueryFailure,
  type PermissionProbe,
  type RowActionRule,
} from '../../../platform/list-query';
import { SELLER_ACCESS_VIEW } from '../../identity';
import {
  AREA_CODE,
  isStateTab,
  LIST_KINDS,
  LIST_TABS,
  parseListSearch,
  SEARCH_CAP,
  STATE_TABS,
  type FileTab,
  type ListKind,
  type ListSearch,
  type ListTab,
  type StateTab,
} from '../domain/seller-list';
import {
  orderProblem,
  queueDirectionOf,
  SELLER_LIST_EXPORT_COLUMNS,
  SELLER_LIST_SORT_KEYS,
  STATE_TAB_CALL_SIZE,
  STATE_TAB_MAX_CALLS,
  STATE_TAB_MAX_ROWS,
  type SellerListExportColumn,
  type SellerListOrder,
  type SellerListRowAction,
  type SellerListSortKey,
} from '../domain/seller-super-list';
import type { SellerAccountDirectory } from './ports/seller-account-directory';
import type { ListCounts, ListedSeller, ListPageQuery } from './ports/seller-list.repository';
import type { EditedNamesByArea } from './ports/service-area-names.repository';
import {
  decorateListRows,
  ListLog,
  listAreasOf,
  listIdentityFailed,
  stateTabCounts,
  type SellerListDependencies,
  type SellerListRow,
  type StateTabCounts,
} from './use-cases/list.use-case';

// The admin Sellers list as a super list (phase 3, list 15; CLAUDE.md rule 14) and its export.
// The seven tabs of the older list (sellers design 7.8): three read from `sellers`' own rows with
// SQL paging (OFFSET) and a total, four paged by `identity`'s access state, which the list walks
// (at most 20 calls of 100) to reach a page. A read: nothing here acts on a seller. The one row
// action is Open (the seller's file); approve and reject stay on the review page.
//
// Privacy (sellers design 7.8; Hassan M4): clear fields only, no business name, phone, address or
// number. The status and the owner's name and email come from `identity` only for a caller that
// holds `identity.seller-access.view` (asked through the status probe). No log line holds the
// search term, a store name, a name or an email.

export interface SellerSuperListDependencies extends Omit<SellerListDependencies, 'authorisation'> {
  /** Answers `ok` when the caller holds `identity.seller-access.view` (fails closed). */
  readonly statusProbe: PermissionProbe;
  readonly sheetWriter: SheetWriter;
}

export const SELLER_SUPER_LIST_DEFAULT_PAGE_SIZE = 25;
export const SELLER_SUPER_LIST_MAX_PAGE_SIZE = 100;
export const SELLER_EXPORT_MAX_IDS = 200;
/** The rows an export reads at a time (and the `identity` batch of their status). */
const EXPORT_CHUNK = 100;

const SELECTOR_KEYS = ['view', 'kind', 'outsideArea', 'areaCode', 'q'] as const;
const LIST_KEYS = new Set<string>([
  ...SELECTOR_KEYS,
  'sort',
  'direction',
  'page',
  'pageSize',
  'paging',
]);
const EXPORT_KEYS = new Set<string>([
  ...SELECTOR_KEYS,
  'sort',
  'direction',
  'format',
  'columns',
  'ids',
]);

const STATUS_KEY = SELLER_ACCESS_VIEW.key;
const ROW_RULES: readonly RowActionRule<SellerListRow>[] = [{ id: 'open', permission: null }];

/** The request is the raw JSON body: a closed record, checked here. */
export type SellerSuperListInput = unknown;

export type SellerSuperListFailure =
  | ListQueryFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'search.too-broad' }
  | { readonly code: 'sellers.unavailable' }
  | { readonly code: 'file.not-found' }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number };

export interface SellerSuperListRow extends SellerListRow {
  readonly actions: readonly SellerListRowAction[];
}

export interface SellerSuperListPage extends ListPage<SellerSuperListRow> {
  readonly tab: ListTab;
  readonly counts: ListCounts;
  /** The counts of the identity state tabs; null when the caller may not see states. */
  readonly stateCounts: StateTabCounts | null;
  /** Every area of the Market, for the area filter. */
  readonly areas: readonly { readonly code: string; readonly name: string }[];
  /** True when the health of this page could not be read (every row's `health` is then null). */
  readonly healthUnavailable: boolean;
}

interface Selector {
  readonly tab: ListTab;
  readonly kind: ListKind | null;
  readonly outsideArea: boolean;
  readonly areaCode: string | null;
  readonly search: ListSearch | null;
}

const logger = new Logger('SellerSuperList');
const log = new ListLog(logger, 'sellers.seller-list');

const absent = (value: unknown): boolean => value === undefined || value === null || value === '';
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function recordOf(
  input: unknown,
  allowed: ReadonlySet<string>,
): Result<Readonly<Record<string, unknown>>, ListQueryFailure> {
  const record = input === undefined || input === null ? {} : input;
  if (!isRecord(record)) return listQueryInvalid('', 'type');
  const stray = Object.keys(record).find((key) => !allowed.has(key));
  // The name of a stray key is the caller's text: it is not echoed.
  if (stray !== undefined) return listQueryInvalid('', 'unknown-field');
  return ok(record);
}

function parseSelector(
  record: Readonly<Record<string, unknown>>,
): Result<Selector, ListQueryFailure> {
  let tab: ListTab = 'all';
  if (!absent(record['view'])) {
    const found = LIST_TABS.find((candidate) => candidate === record['view']);
    if (found === undefined) return listQueryInvalid('view', 'value');
    tab = found;
  }
  let kind: ListKind | null = null;
  if (!absent(record['kind'])) {
    const found = LIST_KINDS.find((candidate) => candidate === record['kind']);
    if (found === undefined) return listQueryInvalid('kind', 'value');
    if (tab !== 'awaiting-review') return listQueryInvalid('kind', 'tab');
    kind = found;
  }
  let outsideArea = false;
  const outside = record['outsideArea'];
  if (!absent(outside) && outside !== false && outside !== 'false') {
    if (outside !== true && outside !== 'true') return listQueryInvalid('outsideArea', 'value');
    if (tab !== 'incomplete') return listQueryInvalid('outsideArea', 'tab');
    outsideArea = true;
  }
  let areaCode: string | null = null;
  if (!absent(record['areaCode'])) {
    const value = record['areaCode'];
    if (typeof value !== 'string' || !AREA_CODE.test(value)) {
      return listQueryInvalid('areaCode', 'format');
    }
    if (isStateTab(tab)) return listQueryInvalid('areaCode', 'tab');
    areaCode = value;
  }
  let search: ListSearch | null = null;
  if (!absent(record['q'])) {
    const parsed = parseListSearch(record['q']);
    if (parsed.problem !== null) return listQueryInvalid('q', parsed.problem);
    if (parsed.search !== null && isStateTab(tab)) return listQueryInvalid('q', 'tab');
    search = parsed.search;
  }
  return ok({ tab, kind, outsideArea, areaCode, search });
}

function parseQuery(
  record: Readonly<Record<string, unknown>>,
  tab: ListTab,
): Result<ListQuery<SellerListSortKey>, ListQueryFailure> {
  const query = parseListQuery<SellerListSortKey>(record, {
    sorts: SELLER_LIST_SORT_KEYS,
    defaultSort: 'queue',
    defaultDirection: (sort) => (sort === 'name' ? 'asc' : queueDirectionOf(tab)),
    defaultPageSize: SELLER_SUPER_LIST_DEFAULT_PAGE_SIZE,
    maxPageSize: SELLER_SUPER_LIST_MAX_PAGE_SIZE,
    maxPage: MAX_PAGED_ROWS,
  });
  if (!query.ok) return query;
  const problem = orderProblem(tab, { key: query.value.sort, direction: query.value.direction });
  if (problem !== null) return listQueryInvalid(problem, 'tab');
  return query;
}

/** Whether the caller holds `identity.seller-access.view`; a failed probe counts as no. */
async function statusShown(deps: SellerSuperListDependencies, context: CallContext) {
  return (await heldKeys(context, { [STATUS_KEY]: deps.statusProbe })).has(STATUS_KEY);
}

/** The filters of a file tab as the repository reads them. */
function pageQuery(
  deps: SellerSuperListDependencies,
  context: CallContext,
  selector: Selector,
  onlyIds: readonly Id<'Seller'>[] | null,
  order: SellerListOrder,
  offset: number,
  take: number,
): ListPageQuery {
  return {
    kind: selector.kind,
    outsideArea: selector.outsideArea,
    openAreaCodes: deps.onboardingAreas.openCodes(context.market),
    areaCode: selector.areaCode,
    onlyIds,
    after: null,
    take,
    order,
    offset,
  };
}

function readTab(
  deps: SellerSuperListDependencies,
  context: CallContext,
  tab: FileTab,
  query: ListPageQuery,
): Promise<readonly ListedSeller[]> {
  const { list } = deps;
  if (tab === 'awaiting-review') return list.awaitingReview(context.market, query);
  if (tab === 'incomplete') return list.incomplete(context.market, query);
  return list.all(context.market, query);
}

/** The ids a search names, or null without a search; `too-broad` past the cap (never a cut). */
async function candidatesOf(
  deps: SellerSuperListDependencies,
  context: CallContext,
  search: ListSearch | null,
): Promise<readonly Id<'Seller'>[] | null | 'too-broad'> {
  if (search === null) return null;
  const found = await deps.list.searchCandidates(context.market, search, SEARCH_CAP);
  return found.overflow ? 'too-broad' : found.ids;
}

/** Runs one read-only unit on `sellers`' tables; a failure is `sellers.unavailable`. */
async function inUnit<T>(
  deps: SellerSuperListDependencies,
  context: CallContext,
  work: () => Promise<Result<T, SellerSuperListFailure>>,
): Promise<Result<T, SellerSuperListFailure>> {
  try {
    return await deps.unitOfWork.run<T, SellerSuperListFailure>(context.market, work, {
      readOnly: true,
    });
  } catch (error) {
    log.fail(context, 'read-failed', error);
    return err({ code: 'sellers.unavailable' });
  }
}

/** The files of `ids` in their order; a seller with no file in the Market is left out. */
async function filesOf(
  deps: SellerSuperListDependencies,
  context: CallContext,
  ids: readonly Id<'Seller'>[],
): Promise<readonly ListedSeller[]> {
  if (ids.length === 0) return [];
  const files = await deps.list.all(context.market, {
    kind: null,
    outsideArea: false,
    openAreaCodes: [],
    areaCode: null,
    onlyIds: ids,
    after: null,
    take: ids.length,
  });
  const byId = new Map(files.map((file) => [file.sellerId, file]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

const STATE_COUNT_OF: Readonly<Record<StateTab, keyof StateTabCounts>> = {
  'changes-needed': 'changesNeeded',
  'not-approved': 'notApproved',
  approved: 'approved',
  suspended: 'suspended',
};

type IdentityFailure =
  { readonly code: 'access.denied' } | { readonly code: 'sellers.unavailable' };

/**
 * Walks `identity`'s pages of a state tab, newest first, until `want` ids are read or the tab
 * ends, in at most `maxCalls` calls of 100. `next` is where `identity` goes on (null at the end).
 */
async function walkState(
  directory: SellerAccountDirectory,
  context: CallContext,
  tab: StateTab,
  want: number,
  maxCalls: number,
): Promise<
  Result<
    {
      readonly ids: readonly Id<'Seller'>[];
      readonly next: Id<'Seller'> | null;
      readonly counts: StateTabCounts;
    },
    IdentityFailure
  >
> {
  const ids: Id<'Seller'>[] = [];
  let next: Id<'Seller'> | null = null;
  let counts: StateTabCounts | null = null;
  for (let calls = 0; calls < maxCalls; calls += 1) {
    let answer;
    try {
      answer = await directory.idsByState(context, {
        state: STATE_TABS[tab].state,
        before: next,
        limit: Math.max(1, Math.min(STATE_TAB_CALL_SIZE, want - ids.length)),
        reapplyLimitReached: STATE_TABS[tab].reapplyLimitReached,
      });
    } catch (error) {
      return listIdentityFailed(log, context, error);
    }
    counts ??= stateTabCounts(answer);
    ids.push(...answer.sellerIds);
    next = answer.next;
    if (next === null || ids.length >= want) break;
  }
  return ok({ ids, next, counts: counts! });
}

function withActions(rows: readonly SellerListRow[]): SellerSuperListRow[] {
  return rows.map((row) => ({
    ...row,
    actions: rowActions(row, ROW_RULES, new Set<string>()) as SellerListRowAction[],
  }));
}

/**
 * One page of the Sellers list: a tab, its filters and sort, page numbers with a total
 * (`paging=pages`) or Previous/Next without one, the tab counts and each row's actions.
 */
export async function listSellers(
  deps: SellerSuperListDependencies,
  context: CallContext,
  input: SellerSuperListInput,
): Promise<Result<SellerSuperListPage, SellerSuperListFailure>> {
  const record = recordOf(input, LIST_KEYS);
  if (!record.ok) return record;
  const selector = parseSelector(record.value);
  if (!selector.ok) return selector;
  const { tab } = selector.value;
  const query = parseQuery(record.value, tab);
  if (!query.ok) return query;
  const { page, pageSize, paging } = query.value;
  const { offset, limit } = pageWindow(query.value);
  // Page numbers stop at MAX_PAGED_ROWS (the extra row of Previous/Next only tells `hasNext`).
  if (offset + pageSize > MAX_PAGED_ROWS) return listQueryInvalid('page', 'range');

  const showStatus = await statusShown(deps, context);
  if (isStateTab(tab) && !showStatus) return err({ code: 'access.denied' });
  const edited: EditedNamesByArea = await deps.areaNames.edited(context.market);
  const areas = listAreasOf(deps, context, edited);

  let pageOf: ListPage<ListedSeller>;
  let counts: ListCounts;
  let stateCounts: StateTabCounts | null = null;
  if (isStateTab(tab)) {
    if (offset + pageSize > STATE_TAB_MAX_ROWS) return listQueryInvalid('page', 'range');
    const walked = await walkState(
      deps.directory,
      context,
      tab,
      Math.min(offset + limit, STATE_TAB_MAX_ROWS),
      STATE_TAB_MAX_CALLS,
    );
    if (!walked.ok) return walked;
    stateCounts = walked.value.counts;
    const ids = walked.value.ids;
    // `identity` paged fewer ids than asked while more follow: the page is out of reach.
    const more = walked.value.next !== null;
    if (ids.length < offset + pageSize && more) {
      return listQueryInvalid('page', 'range');
    }
    const kept = ids.slice(offset, offset + pageSize);
    const hasNext =
      paging === 'pages'
        ? null
        : ids.length > offset + pageSize || (ids.length === offset + pageSize && more);
    const read = await inUnit(deps, context, async () =>
      ok({
        counts: await deps.list.counts(context.market),
        files: await filesOf(deps, context, kept),
      }),
    );
    if (!read.ok) return read;
    counts = read.value.counts;
    pageOf =
      hasNext === null
        ? listPage(read.value.files, query.value, stateCounts[STATE_COUNT_OF[tab]])
        : { items: read.value.files, page, pageSize, paging, total: null, hasNext };
  } else {
    const order: SellerListOrder = { key: query.value.sort, direction: query.value.direction };
    const fileTab = tab;
    const read = await inUnit(deps, context, async () => {
      const tabCounts = await deps.list.counts(context.market);
      const named = await candidatesOf(deps, context, selector.value.search);
      if (named === 'too-broad') return err({ code: 'search.too-broad' as const });
      if (named !== null && named.length === 0) {
        return ok({ counts: tabCounts, rows: [] as readonly ListedSeller[], total: 0 });
      }
      const filter = pageQuery(deps, context, selector.value, named, order, offset, limit);
      const total =
        paging === 'pages' ? await deps.list.countMatching(context.market, fileTab, filter) : null;
      const rows = await readTab(deps, context, fileTab, filter);
      return ok({ counts: tabCounts, rows, total });
    });
    if (!read.ok) return read;
    counts = read.value.counts;
    pageOf = listPage(read.value.rows, query.value, read.value.total);
    if (showStatus) {
      try {
        const answer = await deps.directory.idsByState(context, {
          state: null,
          before: null,
          limit: 0,
          reapplyLimitReached: null,
        });
        stateCounts = stateTabCounts(answer);
      } catch (error) {
        return listIdentityFailed(log, context, error);
      }
    }
  }

  const decorated = await decorateListRows(deps, log, context, pageOf.items, showStatus, edited);
  if (!decorated.ok) return decorated;
  return ok({
    ...pageOf,
    items: withActions(decorated.value.rows),
    tab,
    counts,
    stateCounts,
    areas,
    healthUnavailable: decorated.value.healthUnavailable,
  });
}

// --- the export --------------------------------------------------------------------------------

const BASE_HEADERS = [
  'Store',
  'Slug',
  'Status',
  'Kind',
  'Submitted',
  'Service area',
  'Timezone',
  'Created',
  'Last changed',
  'Health band',
  'Health score',
] as const;
const HEADERS: Readonly<Record<SellerListExportColumn, string>> = { 'seller-id': 'Seller ID' };

function cellsOf(row: SellerListRow, picked: readonly SellerListExportColumn[]): ExportCell[] {
  return [
    row.storeName ?? '',
    row.slug ?? '',
    row.status === null || row.status === 'hidden' ? '' : row.status,
    row.kind ?? '',
    row.submittedAt ?? '',
    row.serviceAreaName ?? row.serviceAreaCode ?? '',
    row.timezone ?? '',
    row.createdAt,
    row.lastChangedAt,
    row.health?.band ?? '',
    row.health?.score ?? '',
    ...picked.map((column) => (column === 'seller-id' ? row.sellerId : '')),
  ];
}

/**
 * The sellers of the list as a CSV or XLSX file: the chosen `ids` (seller ids, at most 200; an id
 * with no file in the Market refuses the whole request as not found; no filter or sort beside
 * them) or what the selector keys match, in the list's sort, read in pages of 100. More than
 * {@link LIST_EXPORT_MAX_ROWS} is refused whole (`batch.too-large`). The status is blank
 * unless the caller holds `identity.seller-access.view`; a state tab needs it. The owner's name and
 * email are never exported (security review: personal data, no export permission or audit). CSV cells that start with = + - @ get a leading quote (the shared builder).
 */
export async function exportSellers(
  deps: SellerSuperListDependencies,
  context: CallContext,
  input: SellerSuperListInput,
): Promise<Result<ExportFile, SellerSuperListFailure>> {
  const record = recordOf(input, EXPORT_KEYS);
  if (!record.ok) return record;
  const format = parseExportFormat(record.value['format']);
  if (!format.ok) return format;
  const columns = parseExportColumns(record.value['columns'], SELLER_LIST_EXPORT_COLUMNS);
  if (!columns.ok) return columns;

  const showStatus = await statusShown(deps, context);
  let chunks: () => AsyncGenerator<readonly ListedSeller[]>;
  if (!absent(record.value['ids'])) {
    const raw = record.value['ids'];
    if (typeof raw !== 'string') return listQueryInvalid('ids', 'type');
    const clash = [...SELECTOR_KEYS, 'sort', 'direction'].find((key) => !absent(record.value[key]));
    if (clash !== undefined) return listQueryInvalid(clash, 'with-ids');
    const listed = parseExportIds(raw, SELLER_EXPORT_MAX_IDS, (part) => {
      const parsed = parseId<'Seller'>(part.trim().toLowerCase());
      return parsed.ok ? parsed.value : null;
    });
    if (!listed.ok) return listed;
    const wanted = listed.value;
    const read = await inUnit(deps, context, async () => ok(await filesOf(deps, context, wanted)));
    if (!read.ok) return read;
    if (read.value.length !== wanted.length) return err({ code: 'file.not-found' });
    const files = read.value;
    chunks = async function* () {
      for (let start = 0; start < files.length; start += EXPORT_CHUNK) {
        yield files.slice(start, start + EXPORT_CHUNK);
      }
      await Promise.resolve();
    };
  } else {
    const selector = parseSelector(record.value);
    if (!selector.ok) return selector;
    const { tab } = selector.value;
    const query = parseQuery(record.value, tab);
    if (!query.ok) return query;
    if (isStateTab(tab)) {
      if (!showStatus) return err({ code: 'access.denied' });
      const first = await walkStateForExport(deps, context, tab);
      if (!first.ok) return first;
      chunks = first.value;
    } else {
      const order: SellerListOrder = { key: query.value.sort, direction: query.value.direction };
      const sized = await inUnit(deps, context, async () => {
        const named = await candidatesOf(deps, context, selector.value.search);
        if (named === 'too-broad') return err({ code: 'search.too-broad' as const });
        const filter = pageQuery(deps, context, selector.value, named, order, 0, EXPORT_CHUNK);
        const total =
          named !== null && named.length === 0
            ? 0
            : await deps.list.countMatching(context.market, tab, filter);
        return ok({ filter, total });
      });
      if (!sized.ok) return sized;
      const { filter, total } = sized.value;
      if (total > LIST_EXPORT_MAX_ROWS) {
        return err({ code: 'batch.too-large', max: LIST_EXPORT_MAX_ROWS, total });
      }
      chunks = async function* () {
        for (let offset = 0; offset < total; offset += EXPORT_CHUNK) {
          const read = await inUnit(deps, context, async () =>
            ok(await readTab(deps, context, tab, { ...filter, offset })),
          );
          if (!read.ok) throw new Error('sellers.seller-list-export: the read failed');
          if (read.value.length === 0) return;
          yield read.value;
        }
      };
    }
  }

  const edited = await deps.areaNames.edited(context.market);
  const picked = columns.value;
  const source = chunks;
  async function* groups(): AsyncGenerator<readonly (readonly ExportCell[])[]> {
    yield [[...BASE_HEADERS, ...picked.map((column) => HEADERS[column])]];
    for await (const files of source()) {
      const decorated = await decorateListRows(deps, log, context, files, showStatus, edited);
      if (!decorated.ok) throw new Error(`sellers.seller-list-export: ${decorated.error.code}`);
      yield decorated.value.rows.map((row) => cellsOf(row, picked));
    }
  }
  return ok(
    buildExportFile({
      format: format.value,
      baseName: 'sellers',
      sheetName: 'Sellers',
      day: deps.clock.now().toString().slice(0, 10),
      groups: groups(),
      sheetWriter: deps.sheetWriter,
    }),
  );
}

/**
 * A state tab's export: the first `identity` page is read now (its counts size the file, and a
 * refusal or an outage answers before the download starts); the rest are read as the file is
 * written, 100 ids and their files at a time.
 */
async function walkStateForExport(
  deps: SellerSuperListDependencies,
  context: CallContext,
  tab: StateTab,
): Promise<Result<() => AsyncGenerator<readonly ListedSeller[]>, SellerSuperListFailure>> {
  const first = await walkState(deps.directory, context, tab, STATE_TAB_CALL_SIZE, 1);
  if (!first.ok) return first;
  const total = first.value.counts[STATE_COUNT_OF[tab]];
  if (total > LIST_EXPORT_MAX_ROWS) {
    return err({ code: 'batch.too-large', max: LIST_EXPORT_MAX_ROWS, total });
  }
  const opening = first.value;
  return ok(async function* () {
    let ids = opening.ids;
    let next = opening.next;
    let read = 0;
    for (;;) {
      const page = ids;
      const files = await inUnit(deps, context, async () => ok(await filesOf(deps, context, page)));
      if (!files.ok) throw new Error('sellers.seller-list-export: the read failed');
      if (files.value.length > 0) yield files.value;
      read += ids.length;
      if (next === null || ids.length === 0 || read >= LIST_EXPORT_MAX_ROWS) return;
      const answer = await deps.directory.idsByState(context, {
        state: STATE_TABS[tab].state,
        before: next,
        limit: STATE_TAB_CALL_SIZE,
        reapplyLimitReached: STATE_TABS[tab].reapplyLimitReached,
      });
      ids = answer.sellerIds;
      next = answer.next;
    }
  });
}
