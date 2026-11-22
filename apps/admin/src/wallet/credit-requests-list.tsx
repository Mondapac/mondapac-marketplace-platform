'use client';

import {
  Banner,
  Button,
  EmptyState,
  SuperList,
  browserStorage,
  listSkeletonRowCount,
  prefsKey,
  readIds,
  toast,
  useListLoading,
  useRowSelection,
  useSuperListQuery,
  writeIds,
  type MenuItem,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import type { ListPagingMode } from '../sales/cursor-paging.ts';
import { stepStack } from '../sales/cursor-paging.ts';
import { SelectionBar } from '../sales/selection-bar.tsx';
import { numberFormat } from '../shared/intl.ts';
import { CreditDecideDialogs, CreditDetailsDialog } from './list/credit-requests-dialogs.tsx';
import type { DecideAsk } from './list/credit-requests-dialogs.tsx';
import {
  DEFAULT_COLUMNS,
  cleanColumns,
  type OptionalColumn,
} from './list/credit-requests-columns.ts';
import { CreditRequestsColumnsPanel } from './list/credit-requests-columns-panel.tsx';
import { CreditRequestsBulk } from './list/credit-requests-export.tsx';
import { CreditRequestsFilterPanel } from './list/credit-requests-filter-panel.tsx';
import {
  DEFAULT_QUERY,
  FILTER_FIELDS,
  MAX_PAGED_ROWS,
  PAGE_SIZES,
  ROW_ACTIONS,
  SEARCH_MAX,
  SELECTION_MAX,
  VIEWS,
  filterCount,
  type CreditListPage,
  type CreditListRow,
  type FilterField,
  type Filters,
  type Query,
  type View,
  type ViewCounts,
} from './list/credit-requests-list-types.ts';
import { creditSearchRoute, queryString } from './list/credit-requests-query.ts';
import { CreditRequestsSortPanel } from './list/credit-requests-sort-panel.tsx';
import { CreditRequestsTable } from './list/credit-requests-table.tsx';
import { formatMinor } from './money.ts';
import type { AdminCredit } from './types.ts';

type Failure = 'denied' | 'refused' | 'unavailable';

function failureOf(status: number, code: string): Failure {
  if (status === 403) return 'denied';
  // The API refused the query itself: asking again can never work.
  if (code === 'validation.failed') return 'refused';
  return 'unavailable';
}

const noActions = () => [];

// The query rules of the kit hook, kept at module level so they stay the same between renders.
// Every change but a page move starts again on the first page, with no cursor.
const forView = (view: string): Query => ({ ...DEFAULT_QUERY, view: view as View });
const withView = (current: Query, view: string): Query => ({
  ...current,
  view: view as View,
  cursors: [],
});
const searchOf = (current: Query): string => current.q;
// Text that is not an id asks for nothing: the query keeps the search it had, and the box says so.
const withSearch = (current: Query, text: string): Query =>
  creditSearchRoute(text).kind === 'not-id' ? current : { ...current, q: text, cursors: [] };

/**
 * The admin Credit requests list (super list 24): the views with their counts, one search box (a
 * request id or a customer account id), the filter, sort and column panels with their chips, then
 * one page of requests with the row Actions menu. It follows the Market's List paging setting: page
 * numbers with a total and any sort, or Previous and Next, newest requested first. Rows can be
 * selected for the one bulk action, Export; money is never decided in bulk. Approve and Reject are
 * in the row menu and ask to confirm (Approve: a typed id and a two-step code); the list reads its
 * rows again after each, nothing is edited in place. Saved filters wait for their API (#1061).
 */
export function CreditRequestsList({
  paging,
  accountId,
  csrfToken,
  marketId,
  zone,
  initialView = 'pending',
}: {
  /** The Market's "List paging" setting, Previous and next when it could not be read. */
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly csrfToken: string;
  readonly marketId: string;
  /** The IANA zone of the table's times and of the date presets (ADR-0005). */
  readonly zone: string;
  /** The view a link opens (`?view=`), Pending by default. */
  readonly initialView?: View;
}) {
  const t = useTranslations('wallet.list');
  const tw = useTranslations('wallet');
  const ts = useTranslations('sales-lists');
  const tl = useTranslations('load');
  const locale = useLocale();
  const { query, draft, setDraft, change, goToPage, paginate, openView, reset } =
    useSuperListQuery<Query>({
      defaultQuery: { ...DEFAULT_QUERY, view: initialView },
      forView,
      withView,
      searchOf,
      withSearch,
    });
  // A change of what is listed starts on the first page with no cursor.
  const changeList = (patch: Partial<Query>) => change({ cursors: [], ...patch });

  const [answer, setAnswer] = useState<CreditListPage | null>(null);
  // The view counts of the last answer: they stay while a page loads or a read fails.
  const [counts, setCounts] = useState<ViewCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [hinted, setHinted] = useState(false);
  const [columns, setColumns] = useState<readonly OptionalColumn[]>(DEFAULT_COLUMNS);
  const [decide, setDecide] = useState<DecideAsk>(null);
  const [details, setDetails] = useState<AdminCredit | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef(0);
  const storageKey = prefsKey('admin', marketId, accountId, 'credit-requests-columns');
  // After a page change or a decision the focus moves to the top of the list, so a keyboard or
  // screen reader user starts on the rows and not on the control they used.
  const listTop = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  // When the rows on show were read: an export of "all matching" reads its date preset on this
  // clock, so the file covers the same window as the screen even across midnight.
  const [readAt, setReadAt] = useState<Date | null>(null);
  const focusList = useRef(false);

  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  // One task later than the dialog that closed with the refusal: it gives the focus back to its
  // opener in a timeout of its own, and the message takes it after that.
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => noticeRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [notice]);

  // The date presets are read at each load (and each Try again), on the clock of the list's zone.
  // `quiet`: read again after a decision without dimming the rows or dropping them on a failure.
  const load = useCallback(
    async (asked: Query, quiet = false) => {
      const now = new Date();
      const request = queryString(asked, { paging, zone, now });
      const ticket = ++latest.current;
      if (!quiet) {
        setLoading(true);
        setFailure(null);
      }
      const result = await callApi<CreditListPage>(
        'GET',
        `wallet/admin/credit-requests?${request}`,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        const { status, code, details: problem } = result.failure;
        if (status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        if (quiet) return;
        if (code === 'validation.failed') {
          // The panel never builds an invalid query: say what the API refused, once, for support.
          console.warn('wallet.credit-requests-refused', problem?.fields ?? []);
        }
        setFailure(failureOf(status, code));
        return;
      }
      setFailure(null);
      setAnswer(result.body);
      setCounts(result.body.counts);
      setReadAt(now);
    },
    [paging, zone],
  );

  // A query that is equal in content is not a new list: load again only when it changed.
  const queryNow = useRef(query);
  queryNow.current = query;
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    void load(queryNow.current);
  }, [load, queryKey]);

  // A new view, search, filter or sort is another list: the selection does not follow it. Paging
  // keeps it, so rows can be ticked on several pages.
  // The search goes in as it is sent (an id lower-cased), so the same id typed in other case
  // keeps the ticks.
  const listKey = JSON.stringify([
    query.view,
    creditSearchRoute(query.q),
    query.filters,
    query.sort,
    query.direction,
  ]);
  const rows = answer?.entries;
  const pageIds = useMemo(() => rows?.map((row) => row.id) ?? [], [rows]);
  const selection = useRowSelection(pageIds, SELECTION_MAX, listKey);
  // Panel loading L2: skeleton rows on the first load, dimmed rows on a later one.
  const status = useListLoading(loading, answer !== null);
  // A first load that runs past 30 s gives up: its answer is dropped and Try again starts anew.
  useEffect(() => {
    if (!status.stalled) return;
    latest.current += 1;
    setLoading(false);
    setFailure('unavailable');
  }, [status.stalled]);

  // Not while a dialog is open, and one task later than the dialog that just closed: it gives the
  // focus back to its opener in a timeout of its own, and the list takes it after that.
  const dialogOpen = decide !== null || details !== null;
  useEffect(() => {
    if (loading || dialogOpen || !focusList.current) return;
    const timer = setTimeout(() => {
      focusList.current = false;
      listTop.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [loading, answer, dialogOpen]);

  // The API answers with a total only for page numbers: its answer, not the setting, says which
  // footer fits the rows on show.
  const mode: ListPagingMode = answer === null || answer.total === null ? 'prev-next' : paging;
  const pageSize = answer?.pageSize ?? query.pageSize;
  const page = mode === 'pages' ? (answer?.page ?? query.page) : query.cursors.length + 1;
  const start = (page - 1) * pageSize;

  // A page past the end (requests left the view meanwhile) goes back one page. Once per answer:
  // the step back changes the query before the next read starts, and must not step again.
  const steppedBack = useRef<CreditListPage | null>(null);
  useEffect(() => {
    if (answer === null || loading || failure !== null || answer.entries.length > 0) return;
    if (steppedBack.current === answer) return;
    steppedBack.current = answer;
    if (mode === 'pages' && (answer.page ?? 1) > 1) {
      const last =
        answer.total === null ? 1 : Math.max(1, Math.ceil(answer.total / answer.pageSize));
      goToPage(Math.min(last, (answer.page ?? 1) - 1));
    } else if (mode === 'prev-next' && query.cursors.length > 0) {
      paginate({ cursors: query.cursors.slice(0, -1) });
    }
  }, [answer, loading, failure, mode, query.cursors, goToPage, paginate]);

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const route = creditSearchRoute(query.q);
  const draftRoute = creditSearchRoute(draft);
  // The hint about the typed text waits for the box to lose focus or Enter, so it is not read out
  // at the first keystroke of every search.
  const showHint = hinted && draftRoute.kind === 'not-id';

  const saveColumns = (next: readonly OptionalColumn[]) => {
    setColumns(next);
    writeIds(browserStorage(), storageKey, next);
  };
  const clearAll = () => reset({ q: '', filters: {}, cursors: [] });
  const withoutFilter = (field: FilterField): Filters =>
    Object.fromEntries(Object.entries(query.filters).filter(([name]) => name !== field));

  const filterValue = (field: FilterField): string | null => {
    const value = query.filters[field];
    if (value === undefined) return null;
    switch (field) {
      case 'status':
        return t(`filter.status.${query.filters.status!}`);
      case 'reason':
        return tw(`credit.reason.${query.filters.reason!}`);
      case 'approvalReason':
        return tw(`result.approval-reason.${query.filters.approvalReason!}`);
      case 'requestedBy':
        return t(`filter.by.${query.filters.requestedBy!}`);
      case 'requested':
        return ts(`date-preset.${value}`);
    }
  };
  const chips = [
    ...(route.kind === 'id'
      ? [
          {
            key: 'search',
            label: t('chip-id', { text: route.value }),
            onRemove: () => reset({ q: '', cursors: [] }),
          },
        ]
      : []),
    ...FILTER_FIELDS.flatMap((field) => {
      const value = filterValue(field);
      return value === null
        ? []
        : [
            {
              key: field,
              label: ts('chip', { field: t(`filter.name.${field}`), value }),
              onRemove: () => changeList({ filters: withoutFilter(field) }),
            },
          ];
    }),
  ].map((chip) => ({ ...chip, removeLabel: ts('chip-remove', { filter: chip.label }) }));
  const filtered = chips.length > 0;
  // Previous and next lists newest first only: the sort is fixed there.
  const sortable = paging === 'pages';
  const sortField = t(`sort.field.${sortable ? query.sort : 'requested'}`);
  const sortOrder = t(
    `sort.${sortable ? query.sort : 'requested'}.${!sortable || query.direction === 'desc' ? 'first' : 'second'}`,
  );
  const total = failure === null && mode === 'pages' ? (answer?.total ?? null) : null;

  // After a decision (or a refusal that shows the row is out of date) the list reads its rows
  // again, quietly, and the focus goes to the list.
  const readAgain = (focus: boolean) => {
    focusList.current = focus;
    void load(queryNow.current, true);
  };

  // Exactly the actions the row names (the API decides per caller and state), in the menu's order;
  // an id this panel does not know is ignored. Each opens a dialog; none acts at once.
  const rowActions = (row: CreditListRow): readonly MenuItem[] =>
    ROW_ACTIONS.filter((action) => row.actions.includes(action)).map((action) => ({
      id: action,
      label: t(`actions.${action}`),
      onSelect: () => {
        setNotice(null);
        if (action === 'open') setDetails(row);
        else setDecide({ kind: action, row });
      },
    }));

  const empty = (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : 'inbox'}
      title={filtered ? t('empty.no-match') : t(`empty.${query.view}`)}
      body={filtered ? t('empty.no-match-help') : undefined}
      action={
        filtered ? (
          <Button variant="secondary" onClick={clearAll}>
            {ts('clear-all')}
          </Button>
        ) : undefined
      }
    />
  );

  if (failure === 'denied') {
    return (
      <div>
        <p className="text-fg-muted">{tw('no-access')}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/">
            {tw('back-home')}
          </a>
        </p>
      </div>
    );
  }

  const skeleton = status.skeleton && failure === null;
  const firstLoadError = answer === null && failure === 'unavailable';
  const shown = answer?.entries ?? [];
  const wholePageTicked =
    shown.length > 0 &&
    !selection.allMatching &&
    shown.every((row) => selection.selected.has(row.id));
  const moreThanPage =
    mode === 'pages'
      ? (answer?.total ?? 0) > shown.length
      : answer?.nextCursor !== null || query.cursors.length > 0;

  const table = (
    <div className="flex flex-col gap-4">
      <SelectionBar
        active={selection.selected.size > 0 || selection.allMatching}
        allMatching={selection.allMatching}
        canSelectAll={wholePageTicked && moreThanPage && failure === null}
        labels={{
          selected: t('selection.selected', { count: selection.selected.size }),
          all: total === null ? t('selection.all-open') : t('selection.all', { count: total }),
          selectAll:
            total === null
              ? t('selection.select-all-open')
              : t('selection.select-all', { count: total }),
          clear: t('selection.clear'),
        }}
        onSelectAll={selection.selectAllMatching}
        onClear={selection.clear}
      />
      <div ref={listTop} tabIndex={-1} className="outline-none">
        <CreditRequestsTable
          rows={shown}
          columns={columns}
          zone={zone}
          accountId={accountId}
          empty={empty}
          skeletonRows={skeleton ? listSkeletonRowCount(query.pageSize) : undefined}
          // Rows kept after a failed refresh belong to another list than the query: no actions.
          actions={failure === null ? rowActions : noActions}
          selection={selection}
        />
      </div>
    </div>
  );

  return (
    <>
      <SuperList
        heading={{
          info: t('intro'),
          note: t('zone-note', { zone }),
          actions: (
            <CreditRequestsBulk
              selection={{
                ids: [...selection.selected],
                allMatching: selection.allMatching,
                total,
              }}
              query={query}
              paging={paging}
              zone={zone}
              columns={columns}
              now={readAt ?? undefined}
            />
          ),
        }}
        notice={
          notice === null ? undefined : (
            <div ref={noticeRef} tabIndex={-1} className="outline-none">
              <Banner tone="critical">{notice}</Banner>
            </div>
          )
        }
        views={{
          label: t('views-label'),
          activeId: query.view,
          onSelect: (id) => openView(id),
          items: VIEWS.map((view) => ({
            id: view,
            label: `${t(`view.${view}`)}${counts === null ? '' : ` (${number(counts[view])})`}`,
          })),
          // Saved filters for this list arrive with their API (#1061).
          manage: null,
        }}
        search={{
          label: t('search.label'),
          placeholder: t('search.placeholder'),
          value: draft,
          maxLength: SEARCH_MAX,
          help: t('search.help'),
          onChange: (value) => {
            setHinted(false);
            setDraft(value);
          },
          onBlur: () => setHinted(true),
          onSubmit: (value) => {
            setHinted(true);
            if (creditSearchRoute(value).kind === 'not-id') return;
            changeList({ q: value.trim() });
          },
          extra: showHint ? (
            <p role="status" className="w-full text-sm text-fg-muted">
              {t('search.not-id')}
            </p>
          ) : null,
        }}
        filter={{
          label: ts('filter.button'),
          count: filterCount(query.filters),
          panel: (close) => (
            <CreditRequestsFilterPanel
              filters={query.filters}
              onApply={(filters) => changeList({ filters })}
              close={close}
            />
          ),
        }}
        {...(sortable
          ? {
              sort: {
                label: ts('sort.button'),
                panel: () => (
                  <CreditRequestsSortPanel
                    sort={query.sort}
                    direction={query.direction}
                    onChange={(sort, direction) => changeList({ sort, direction })}
                  />
                ),
              },
            }
          : {})}
        columns={{
          label: ts('columns.button'),
          panel: (close) => (
            <CreditRequestsColumnsPanel columns={columns} onSave={saveColumns} close={close} />
          ),
        }}
        sortedLine={t('sorted', { field: sortField, order: sortOrder })}
        chips={
          filtered
            ? {
                chips,
                clearAll: { label: ts('clear-all'), onClick: clearAll },
                status: total === null || failure !== null ? '' : t('match', { count: total }),
              }
            : null
        }
        failure={
          failure === null
            ? null
            : failure === 'refused'
              ? // Asking again cannot work: no Try again, the words say what to change.
                { message: t('error.refused') }
              : {
                  message: t('error.unavailable'),
                  retry: { label: tl('retry'), onClick: () => void load(query) },
                }
        }
        firstLoadError={firstLoadError}
        loading={loading}
        status={status}
        loadingLabel={tw('loading')}
        slowLabel={tl('slow')}
        ready={answer !== null}
        table={table}
        pagination={
          answer !== null && answer.entries.length > 0 && failure === null
            ? {
                mode,
                page,
                pageSize,
                pageSizes: PAGE_SIZES,
                // Page numbers stop at row 10,000; Previous and next tells the footer one row past
                // this page while another follows, so Next knows where the end is.
                total:
                  mode === 'pages'
                    ? Math.min(answer.total ?? 0, MAX_PAGED_ROWS)
                    : answer.nextCursor !== null
                      ? page * pageSize + 1
                      : start + answer.entries.length,
                maxRows: mode === 'pages' ? MAX_PAGED_ROWS : Number.MAX_SAFE_INTEGER,
                // Previous and next has no total, so no range line.
                range:
                  mode === 'pages' && answer.total !== null
                    ? t('range', {
                        from: number(start + 1),
                        to: number(start + answer.entries.length),
                        total: number(answer.total),
                      })
                    : '',
                labels: {
                  rowsPerPage: ts('paging.rows-per-page'),
                  previous: ts('paging.previous'),
                  next: ts('paging.next'),
                  pages: ts('paging.pages'),
                  page: (n) => ts('paging.page', { page: n }),
                  narrowTitle: ts('paging.narrow'),
                  narrowBody: ts('paging.narrow-help'),
                },
                disabled: loading,
                onPage: (target) => {
                  focusList.current = true;
                  if (mode === 'pages') goToPage(target);
                  else paginate({ cursors: stepStack(query.cursors, target, answer.nextCursor) });
                },
                onPageSize: (size) => paginate({ pageSize: size, cursors: [] }),
              }
            : null
        }
      />
      <CreditDetailsDialog
        row={details}
        accountId={accountId}
        zone={zone}
        onClose={() => setDetails(null)}
      />
      <CreditDecideDialogs
        ask={decide}
        csrfToken={csrfToken}
        onClose={() => setDecide(null)}
        onDone={(kind, row) => {
          setDecide(null);
          setNotice(null);
          toast.success(
            kind === 'approve'
              ? t('notice.approved', { amount: formatMinor(row.amount, row.currency, locale) })
              : t('notice.rejected'),
          );
          readAgain(true);
        }}
        onFailed={(key) => {
          setDecide(null);
          setNotice(tw(`error.${key}` as 'error.unknown'));
          // Any refusal may mean the row on screen is out of date (decided, expired, gone, or
          // approved before the answer was lost): read the list again so it shows the truth.
          readAgain(false);
        }}
      />
    </>
  );
}
