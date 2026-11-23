'use client';

import {
  Button,
  Card,
  EmptyState,
  LedgerTotals,
  SuperList,
  browserStorage,
  listSkeletonRowCount,
  prefsKey,
  readIds,
  useListLoading,
  useRowSelection,
  useSuperListQuery,
  writeIds,
  type LedgerTotalItem,
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
import { formatMinor } from '../shipping/money.ts';
import { DEFAULT_COLUMNS, cleanColumns, type OptionalColumn } from './ledger/ledger-columns.ts';
import { LedgerColumnsPanel } from './ledger/ledger-columns-panel.tsx';
import { LedgerBulk } from './ledger/ledger-export.tsx';
import { LedgerFilterPanel } from './ledger/ledger-filter-panel.tsx';
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
  type LedgerListPage,
  type LedgerListRow,
  type Query,
} from './ledger/ledger-list-types.ts';
import { queryString, stepLabel } from './ledger/ledger-query.ts';
import { LedgerSortPanel } from './ledger/ledger-sort-panel.tsx';
import { LedgerTable } from './ledger/ledger-table.tsx';
import type { Ledger } from './types.ts';

type Failure = 'denied' | 'refused' | 'unavailable';

function failureOf(status: number, code: string): Failure {
  if (status === 403) return 'denied';
  // The API refused the query itself: asking again can never work.
  if (code === 'validation.failed') return 'refused';
  return 'unavailable';
}

type Totals = Ledger['totals'];

/**
 * The totals tiles: what was sold and charged, what refunds took back (goods and delivery fees),
 * the commission returned on them, disputes (only once there are any) and the balance, which may
 * be negative.
 */
function totalItems(
  totals: Totals,
  t: (key: string) => string,
  money: (amount: string) => string,
): LedgerTotalItem[] {
  const refunds = BigInt(totals.refundedSales) + BigInt(totals.refundedShipping);
  const disputes = BigInt(totals.disputeDebits) - BigInt(totals.disputeReinstated);
  return [
    { id: 'sales', label: t('totals.sales'), value: money(totals.sales) },
    { id: 'shipping', label: t('totals.shipping'), value: money(totals.shipping) },
    { id: 'commission', label: t('totals.commission'), value: money(totals.commission) },
    { id: 'refunds', label: t('totals.refunds'), value: money(refunds.toString()) },
    {
      id: 'refunded-commission',
      label: t('totals.refunded-commission'),
      value: money(totals.refundedCommission),
    },
    ...(totals.disputeDebits === '0' && totals.disputeReinstated === '0'
      ? []
      : [{ id: 'disputes', label: t('totals.disputes'), value: money(disputes.toString()) }]),
    ...(totals.sellerCashback === '0'
      ? []
      : [
          {
            id: 'seller-cashback',
            label: t('totals.seller-cashback'),
            value: money(totals.sellerCashback),
          },
        ]),
    {
      id: 'balance',
      label: t('totals.balance'),
      value: money(totals.balance),
      emphasis: true,
    },
  ];
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
 * A seller's ledger for admins (super list 27, compact): the totals over every row of the seller,
 * then one search box (an order or seller order id), the filter, sort and column panels with their
 * chips, and one page of rows with the row Actions menu. It follows the Market's List paging
 * setting: page numbers with a total and any sort, or Previous and next, newest record first.
 * Rows can be selected for the one bulk action, Export. There are no views and no saved filters.
 * The seller is in the path of every call and never a query key.
 */
export function LedgerCard({
  sellerId,
  currency,
  initialTotals,
  paging,
  accountId,
  marketId,
  zone,
}: {
  readonly sellerId: string;
  /** The Market currency of the ledger. */
  readonly currency: string;
  /** The totals the page read; every answer of the list brings fresh ones. */
  readonly initialTotals: Totals;
  /** The Market's "List paging" setting, Previous and next when it could not be read. */
  readonly paging: ListPagingMode;
  /** The signed-in admin (the column choice is kept per admin). */
  readonly accountId: string;
  readonly marketId: string;
  /** The IANA zone of the table's times and of the date presets (ADR-0005). */
  readonly zone: string;
}) {
  const t = useTranslations('commission.ledger');
  const tl = useTranslations('commission.ledger.list');
  const tk = useTranslations('commission.ledger.kind');
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

  const [answer, setAnswer] = useState<LedgerListPage | null>(null);
  const [totals, setTotals] = useState<Totals>(initialTotals);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [hinted, setHinted] = useState(false);
  const [columns, setColumns] = useState<readonly OptionalColumn[]>(DEFAULT_COLUMNS);
  const latest = useRef(0);
  const storageKey = prefsKey('admin', marketId, accountId, 'seller-ledger-columns');
  // After a page change the focus moves to the top of the list, so a keyboard or screen reader
  // user starts on the rows and not on the control they used.
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
  const load = useCallback(
    async (asked: Query) => {
      const now = new Date();
      const askedRoute = idSearchRoute(asked.q);
      const request = queryString(
        asked,
        { paging, zone, currency, now },
        askedRoute.kind === 'id' ? askedRoute.value : '',
      );
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const result = await callApi<LedgerListPage>(
        'GET',
        `commission-payouts/admin/sellers/${sellerId}/ledger?${request}`,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        const { status, code, details: problem } = result.failure;
        if (status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        if (code === 'validation.failed') {
          // The panel never builds an invalid query: say what the API refused, once, for support.
          console.warn('commission-payouts.ledger-refused', problem?.fields ?? []);
        }
        setFailure(failureOf(status, code));
        return;
      }
      setFailure(null);
      setAnswer(result.body);
      setTotals(result.body.totals);
      setReadAt(now);
    },
    [paging, zone, currency, sellerId],
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
  const rows = answer?.entries;
  const pageIds = useMemo(() => rows?.map((row) => row.entryId) ?? [], [rows]);
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

  useEffect(() => {
    if (loading || !focusList.current) return;
    const timer = setTimeout(() => {
      focusList.current = false;
      listTop.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [loading, answer]);

  // The API answers with a total only for page numbers: its answer, not the setting, says which
  // footer fits the rows on show.
  const mode: ListPagingMode = answer === null || answer.total === null ? 'prev-next' : paging;
  const pageSize = answer?.pageSize ?? query.pageSize;
  const page = mode === 'pages' ? (answer?.page ?? query.page) : query.cursors.length + 1;
  const start = (page - 1) * pageSize;

  // A page past the end (rows left the filter meanwhile) goes back one page. Once per answer: the
  // step back changes the query before the next read starts, and must not step again.
  const steppedBack = useRef<LedgerListPage | null>(null);
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
  const money = (amount: string) => formatMinor(amount, currency, locale);
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
      case 'kind':
        return filters.kind === undefined ? null : tk(filters.kind);
      case 'side':
        return filters.side === undefined ? null : tl(`filter.side.${filters.side}`);
      case 'recorded':
        return filters.recorded === undefined ? null : ts(`date-preset.${filters.recorded}`);
      case 'minAmount':
        return filters.minAmount === undefined
          ? null
          : stepLabel(filters.minAmount, currency, locale);
      case 'maxAmount':
        return filters.maxAmount === undefined
          ? null
          : stepLabel(filters.maxAmount, currency, locale);
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
  // Previous and next lists the newest record first only: the sort is fixed there.
  const sortable = paging === 'pages';
  const shownSort = sortable ? query.sort : FIXED_SORT;
  const shownDirection = sortable ? query.direction : DEFAULT_QUERY.direction;
  const sortField = tl(`sort.field.${shownSort}`);
  const sortOrder = tl(
    `sort.${shownSort}.${shownDirection === defaultDirection() ? 'first' : 'second'}`,
  );
  const total = failure === null && mode === 'pages' ? (answer?.total ?? null) : null;

  // Exactly the actions the row names (the API decides per row), in the menu's order; an id this
  // panel does not know is ignored. Open order is a link to the order, so it acts at once.
  const rowActions = (row: LedgerListRow): readonly MenuItem[] =>
    ROW_ACTIONS.filter((action) => row.actions.includes(action)).map((action) => ({
      id: action,
      label: tl(`actions.${action}`),
      onSelect: () => window.location.assign(`/orders/${encodeURIComponent(row.orderId)}`),
    }));

  const empty = (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : 'receipt'}
      title={filtered ? tl('empty.no-match') : t('empty')}
      body={filtered ? tl('empty.no-match-help') : undefined}
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
  const shown = answer?.entries ?? [];
  const wholePageTicked =
    shown.length > 0 &&
    !selection.allMatching &&
    shown.every((row) => selection.selected.has(row.entryId));
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
        <LedgerTable
          rows={shown}
          columns={columns}
          zone={zone}
          currency={currency}
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
      <LedgerTotals items={totalItems(totals, t, money)} />
      <SuperList
        heading={{
          subtitle: filtered ? tl('intro-filtered') : tl('intro'),
          actions: (
            <LedgerBulk
              sellerId={sellerId}
              selection={{
                ids: [...selection.selected],
                allMatching: selection.allMatching,
                total,
              }}
              query={query}
              paging={paging}
              zone={zone}
              currency={currency}
              columns={columns}
              now={readAt ?? undefined}
            />
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
            <LedgerFilterPanel
              filters={query.filters}
              currency={currency}
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
                  <LedgerSortPanel
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
            <LedgerColumnsPanel columns={columns} onSave={saveColumns} close={close} />
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
                    ? tl('range', {
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
    </Card>
  );
}
