'use client';

import {
  Button,
  Card,
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
import { idSearchRoute, ID_SEARCH_MAX } from '../shared/id-search.ts';
import { numberFormat } from '../shared/intl.ts';
import { DEFAULT_COLUMNS, cleanColumns, type OptionalColumn } from './holds/holds-columns.ts';
import { HoldsColumnsPanel } from './holds/holds-columns-panel.tsx';
import { HoldDialogs, type HoldAsk } from './holds/holds-dialogs.tsx';
import { HoldsBulk } from './holds/holds-export.tsx';
import { HoldsFilterPanel } from './holds/holds-filter-panel.tsx';
import {
  DEFAULT_QUERY,
  FILTER_FIELDS,
  FIXED_SORT,
  MAX_PAGED_ROWS,
  PAGE_SIZES,
  ROW_ACTIONS,
  SELECTION_MAX,
  defaultDirection,
  filterCount,
  type FilterField,
  type Filters,
  type HoldListPage,
  type HoldListRow,
  type Query,
} from './holds/holds-list-types.ts';
import { queryString } from './holds/holds-query.ts';
import { HoldsSortPanel } from './holds/holds-sort-panel.tsx';
import { HoldsTable } from './holds/holds-table.tsx';

type Failure = 'denied' | 'refused' | 'unavailable';

function failureOf(status: number, code: string): Failure {
  if (status === 403) return 'denied';
  // The API refused the query itself: asking again can never work.
  if (code === 'validation.failed') return 'refused';
  return 'unavailable';
}

// The query rules of the kit hook, kept at module level so they stay the same between renders.
// A list with no views: a view change never happens. Every change but a page move starts again on
// the first page, with no cursor.
const forView = (): Query => DEFAULT_QUERY;
const withView = (current: Query): Query => current;
const searchOf = (current: Query): string => current.q;
// Text that is not an id asks for nothing: the query keeps the search it had, and the box says so.
const withSearch = (current: Query, text: string): Query =>
  idSearchRoute(text).kind === 'not-id' ? current : { ...current, q: text, cursors: [] };

const noActions = () => [];

/**
 * The payout holds of one seller (super list 28, compact). A hold covers the whole seller or one
 * seller order and stops payouts until it is released. One search box (a seller order id), the
 * filter, sort and column panels with their chips, then one page of holds with the row Actions
 * menu; it follows the Market's List paging setting: page numbers with a total and any sort, or
 * Previous and next, newest placement first. Rows can be selected for the one bulk action, Export.
 * An admin places only the two manual reasons (Place hold…, in the card's header) and releases a
 * hold from its row menu with a reason from a closed list; both are money actions of level 3 and
 * go through the guarded call. The system's own holds end by themselves, so their rows name no
 * release. There are no views and no saved filters; the old 100-row cap is gone.
 */
export function PayoutHoldsCard({
  sellerId,
  paging,
  accountId,
  marketId,
  zone,
  canPlace,
  csrfToken,
}: {
  readonly sellerId: string;
  /** The Market's "List paging" setting, Previous and next when it could not be read. */
  readonly paging: ListPagingMode;
  /** The signed-in admin (the column choice is kept per admin). */
  readonly accountId: string;
  readonly marketId: string;
  /** The IANA zone of the table's times and of the date presets (ADR-0005). */
  readonly zone: string;
  readonly canPlace: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('payouts.seller.holds');
  const tl = useTranslations('payouts.seller.holds.list');
  const ts = useTranslations('sales-lists');
  const tload = useTranslations('load');
  const locale = useLocale();
  const { query, draft, setDraft, change, goToPage, paginate, reset } = useSuperListQuery<Query>({
    defaultQuery: DEFAULT_QUERY,
    forView,
    withView,
    searchOf,
    withSearch,
  });
  // A change of what is listed starts on the first page with no cursor.
  const changeList = (patch: Partial<Query>) => change({ cursors: [], ...patch });

  const [answer, setAnswer] = useState<HoldListPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [hinted, setHinted] = useState(false);
  const [columns, setColumns] = useState<readonly OptionalColumn[]>(DEFAULT_COLUMNS);
  const [ask, setAsk] = useState<HoldAsk | null>(null);
  const latest = useRef(0);
  const storageKey = prefsKey('admin', marketId, accountId, 'seller-holds-columns');
  // After a page change or a hold placed or released the focus moves to the top of the list, so a
  // keyboard or screen reader user starts on the rows and not on the control they used.
  const listTop = useRef<HTMLDivElement>(null);
  const focusList = useRef(false);
  // When the rows on show were read: an export of "all matching" reads its date presets on this
  // clock, so the file covers the same window as the screen even across midnight.
  const [readAt, setReadAt] = useState<Date | null>(null);

  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  const route = idSearchRoute(query.q);
  const search = route.kind === 'id' ? route.value : '';

  // The date presets are read at each load (and each Try again), on the clock of the list's zone.
  // `quiet`: read again after a hold changed without dimming the rows or dropping them on a failure.
  const load = useCallback(
    async (asked: Query, quiet = false) => {
      const now = new Date();
      const askedRoute = idSearchRoute(asked.q);
      const request = queryString(
        asked,
        { paging, zone, now },
        askedRoute.kind === 'id' ? askedRoute.value : '',
      );
      const ticket = ++latest.current;
      if (!quiet) {
        setLoading(true);
        setFailure(null);
      }
      const result = await callApi<HoldListPage>(
        'GET',
        `commission-payouts/admin/sellers/${sellerId}/payout-holds?${request}`,
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
          console.warn('commission-payouts.holds-refused', problem?.fields ?? []);
        }
        setFailure(failureOf(status, code));
        return;
      }
      setFailure(null);
      setAnswer(result.body);
      setReadAt(now);
    },
    [paging, zone, sellerId],
  );

  // A query that is equal in content is not a new list: load again only when it changed.
  const queryNow = useRef(query);
  queryNow.current = query;
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    void load(queryNow.current);
  }, [load, queryKey]);

  // A new search, filter or sort is another list: the selection does not follow it. Paging keeps
  // it, so rows can be ticked on several pages. The search goes in as it is sent (an id
  // lower-cased), so the same id typed in other case keeps the ticks.
  const listKey = JSON.stringify([search, query.filters, query.sort, query.direction]);
  const rows = answer?.holds;
  const pageIds = useMemo(() => rows?.map((row) => row.holdId) ?? [], [rows]);
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
  const dialogOpen = ask !== null;
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

  // A page past the end (holds left the filter meanwhile) goes back one page. Once per answer: the
  // step back changes the query before the next read starts, and must not step again.
  const steppedBack = useRef<HoldListPage | null>(null);
  useEffect(() => {
    if (answer === null || loading || failure !== null || answer.holds.length > 0) return;
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
  const draftRoute = idSearchRoute(draft);
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
    const { filters } = query;
    switch (field) {
      case 'status':
        return filters.status === undefined ? null : tl(`filter.status.${filters.status}`);
      case 'reason':
        return filters.reason === undefined ? null : t(`reason.${filters.reason}`);
      case 'origin':
        return filters.origin === undefined ? null : tl(`filter.origin.${filters.origin}`);
      case 'scope':
        return filters.scope === undefined ? null : tl(`filter.scope.${filters.scope}`);
      case 'placed':
        return filters.placed === undefined ? null : ts(`date-preset.${filters.placed}`);
    }
  };
  const chips = [
    ...(route.kind === 'id'
      ? [
          {
            key: 'search',
            label: tl('chip-id', { text: route.value }),
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
              label: ts('chip', { field: tl(`filter.name.${field}`), value }),
              onRemove: () => changeList({ filters: withoutFilter(field) }),
            },
          ];
    }),
  ].map((chip) => ({ ...chip, removeLabel: ts('chip-remove', { filter: chip.label }) }));
  const filtered = chips.length > 0;
  // Previous and next lists the newest placement first only: the sort is fixed there.
  const sortable = paging === 'pages';
  const shownSort = sortable ? query.sort : FIXED_SORT;
  const shownDirection = sortable ? query.direction : DEFAULT_QUERY.direction;
  const sortField = tl(`sort.field.${shownSort}`);
  const sortOrder = tl(
    `sort.${shownSort}.${shownDirection === defaultDirection() ? 'first' : 'second'}`,
  );
  const total = failure === null && mode === 'pages' ? (answer?.total ?? null) : null;

  // After a hold is placed or released (or a refusal that shows the row is out of date) the list
  // reads its rows again, quietly, and the focus goes to the list.
  const readAgain = (focus: boolean) => {
    focusList.current = focus;
    void load(queryNow.current, true);
  };

  // Exactly the actions the row names (the API decides per caller and hold), in the menu's order;
  // an id this panel does not know is ignored. Each opens a dialog; none acts at once.
  const rowActions = (row: HoldListRow): readonly MenuItem[] =>
    ROW_ACTIONS.filter((action) => row.actions.includes(action)).map((action) => ({
      id: action,
      label: tl(`actions.${action}`),
      tone: 'critical' as const,
      onSelect: () => setAsk({ kind: action, hold: row }),
    }));

  const done = (kind: 'place' | 'release') => {
    setAsk(null);
    toast.success(t(`done.${kind === 'place' ? 'placed' : 'released'}`));
    readAgain(true);
  };

  const empty = (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : 'shield-check'}
      title={filtered ? tl('empty.no-match') : t('empty.title')}
      body={filtered ? tl('empty.no-match-help') : t('empty.body')}
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
      <Card title={t('title')}>
        <p className="text-fg-muted">{tl('no-access')}</p>
      </Card>
    );
  }

  const skeleton = status.skeleton && failure === null;
  const firstLoadError = answer === null && failure === 'unavailable';
  const shown = answer?.holds ?? [];
  const wholePageTicked =
    shown.length > 0 &&
    !selection.allMatching &&
    shown.every((row) => selection.selected.has(row.holdId));
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
          selected: tl('selection.selected', { count: selection.selected.size }),
          all: total === null ? tl('selection.all-open') : tl('selection.all', { count: total }),
          selectAll:
            total === null
              ? tl('selection.select-all-open')
              : tl('selection.select-all', { count: total }),
          clear: tl('selection.clear'),
        }}
        onSelectAll={selection.selectAllMatching}
        onClear={selection.clear}
      />
      <div ref={listTop} tabIndex={-1} className="outline-none">
        <HoldsTable
          rows={shown}
          columns={columns}
          zone={zone}
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
    <Card title={t('title')}>
      <SuperList
        heading={{
          subtitle: `${
            answer === null
              ? tl('intro')
              : tl('intro-counts', {
                  active: answer.counts.active,
                  released: answer.counts.released,
                })
          } ${tl('note')}`,
          actions: (
            <>
              {canPlace ? (
                <Button onClick={() => setAsk({ kind: 'place' })}>{t('place')}</Button>
              ) : null}
              <HoldsBulk
                sellerId={sellerId}
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
            </>
          ),
        }}
        search={{
          label: tl('search.label'),
          placeholder: tl('search.placeholder'),
          value: draft,
          maxLength: ID_SEARCH_MAX,
          help: tl('search.help'),
          onChange: (value) => {
            setHinted(false);
            setDraft(value);
          },
          onBlur: () => setHinted(true),
          onSubmit: (value) => {
            setHinted(true);
            if (idSearchRoute(value).kind === 'not-id') return;
            changeList({ q: value.trim() });
          },
          extra: showHint ? (
            <p role="status" className="w-full text-sm text-fg-muted">
              {tl('search.not-id')}
            </p>
          ) : null,
        }}
        filter={{
          label: ts('filter.button'),
          count: filterCount(query.filters),
          panel: (close) => (
            <HoldsFilterPanel
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
                  <HoldsSortPanel
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
            <HoldsColumnsPanel columns={columns} onSave={saveColumns} close={close} />
          ),
        }}
        sortedLine={tl('sorted', { field: sortField, order: sortOrder })}
        chips={
          filtered
            ? {
                chips,
                clearAll: { label: ts('clear-all'), onClick: clearAll },
                status: total === null || failure !== null ? '' : tl('match', { count: total }),
              }
            : null
        }
        failure={
          failure === null
            ? null
            : failure === 'refused'
              ? // Asking again cannot work: no Try again, the words say what to change.
                { message: tl('error.refused') }
              : {
                  message: tl('error.unavailable'),
                  retry: { label: tload('retry'), onClick: () => void load(query) },
                }
        }
        firstLoadError={firstLoadError}
        loading={loading}
        status={status}
        loadingLabel={tl('loading')}
        slowLabel={tload('slow')}
        ready={answer !== null}
        table={table}
        pagination={
          answer !== null && answer.holds.length > 0 && failure === null
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
                      : start + answer.holds.length,
                maxRows: mode === 'pages' ? MAX_PAGED_ROWS : Number.MAX_SAFE_INTEGER,
                // Previous and next has no total, so no range line.
                range:
                  mode === 'pages' && answer.total !== null
                    ? tl('range', {
                        from: number(start + 1),
                        to: number(start + answer.holds.length),
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
      <HoldDialogs
        ask={ask}
        sellerId={sellerId}
        csrfToken={csrfToken}
        onClose={() => setAsk(null)}
        onDone={done}
        onRefused={() => readAgain(false)}
      />
    </Card>
  );
}
