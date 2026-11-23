'use client';

import {
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
import { callApi } from '../../api/client.ts';
import { SelectionBar } from '../../orders/selection-bar.tsx';
import { exponentOf } from '../../price/money.ts';
import { numberFormat } from '../../shared/intl.ts';
import type { ListPaging, OwnPayoutRow, OwnPayouts } from '../payout-types.ts';
import { DEFAULT_COLUMNS, cleanColumns, type OptionalColumn } from './payouts-columns.ts';
import { PayoutsBulk } from './payouts-export.tsx';
import {
  DEFAULT_QUERY,
  MAX_PAGED_ROWS,
  PAGE_SIZES,
  SEARCH_MAX,
  SELECTION_MAX,
  VIEWS,
  filterCount,
  type Query,
  type Sort,
  type View,
} from './payouts-list-types.ts';
import {
  PayoutsColumnsPanel,
  PayoutsFilterPanel,
  PayoutsSortPanel,
  stepLabel,
} from './payouts-panels.tsx';
import { payoutSearchRoute, queryString } from './payouts-query.ts';
import { PayoutsTable } from './payouts-table.tsx';

type Failure = 'refused' | 'unavailable';

function failureOf(status: number, code: string): Failure {
  // The API refused the query itself (a page past row 10,000, a cursor of another sort): asking
  // again can never work.
  return status === 400 && code === 'validation.failed' ? 'refused' : 'unavailable';
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
// Text that is not a payout id asks for nothing: the query keeps the search it had.
const withSearch = (current: Query, text: string): Query =>
  payoutSearchRoute(text).kind === 'not-an-id'
    ? current
    : { ...current, q: text.trim(), cursors: [] };

/** The cursors after a move to `target`: one page on pushes the answer's cursor, one back drops. */
function stepStack(stack: readonly string[], target: number, next: string | null) {
  const page = stack.length + 1;
  if (target === page + 1) return next === null ? stack : [...stack, next];
  if (target === page - 1) return stack.slice(0, -1);
  return stack;
}

/**
 * The seller's payout list (super list 33), in the Payout history section of Earnings: a view for
 * each status with its count, a search by payout id, the filter (Payout on, amount at least and
 * at most), sort and column panels with their chips, then one page of payouts with a row Actions
 * menu. It follows the Market's List paging setting: page numbers with a total and any sort, or
 * Previous and next on the API's cursor, latest payout day first. Rows can be selected for the
 * one bulk action, Export; money never moves in bulk. The payout day (`slotAt`) is the one date:
 * column, sort, cursor and filter, with its days read on the STORE's clock. The column choice is
 * the seller's own and lives in this browser's storage. Saved filters wait for the API (the saved
 * tabs seam is left empty).
 */
export function PayoutsList({
  initial,
  paging,
  zone,
  currency,
  accountId,
  marketId,
}: {
  /** The first page the page server read; null when that read failed (the list offers Try again). */
  readonly initial: OwnPayouts | null;
  readonly paging: ListPaging;
  /** The store's IANA zone: the dates and the days of the filter are on its clock (ADR-0005). */
  readonly zone: string;
  /** The currency of the amount filter: the ledger's. */
  readonly currency: string;
  readonly accountId: string;
  readonly marketId: string;
}) {
  const t = useTranslations('payouts.list');
  const th = useTranslations('payouts.history');
  const tl = useTranslations('load');
  const locale = useLocale();
  const { query, draft, setDraft, change, goToPage, paginate, openView, reset } =
    useSuperListQuery<Query>({
      defaultQuery: DEFAULT_QUERY,
      forView,
      withView,
      searchOf,
      withSearch,
    });
  const exponent = exponentOf(currency);
  // A change of what is listed starts on the first page with no cursor.
  const changeList = (patch: Partial<Query>) => change({ cursors: [], ...patch });

  // The page the server read opens the list: no first request for the same query.
  const [answer, setAnswer] = useState<OwnPayouts | null>(initial);
  const [counts, setCounts] = useState(initial?.counts ?? null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(initial === null ? 'unavailable' : null);
  const [hinted, setHinted] = useState(false);
  const [columns, setColumns] = useState<readonly OptionalColumn[]>(DEFAULT_COLUMNS);
  // When the rows on show were read: an export of "all matching" reads its day preset on this
  // clock, so the file covers the same window as the screen even across midnight.
  const [readAt, setReadAt] = useState<Date | null>(initial === null ? null : new Date());
  const latest = useRef(0);
  const storageKey = prefsKey('seller', marketId, accountId, 'payouts-columns');
  // After a page change the focus moves to the top of the list, so a keyboard or screen reader
  // user starts on the new rows and not on the pager they used.
  const listTop = useRef<HTMLDivElement>(null);
  const focusList = useRef(false);

  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  // The day presets are read at each load (and each Try again), on the store's clock, so a tab
  // left open past midnight does not keep asking for yesterday's "Today".
  const load = useCallback(
    async (asked: Query) => {
      const now = new Date();
      const request = queryString(asked, { paging, zone, now, exponent });
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const result = await callApi<OwnPayouts>(
        'GET',
        `commission-payouts/seller/payouts?${request}`,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        const { status, code } = result.failure;
        if (status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        setFailure(failureOf(status, code));
        return;
      }
      setAnswer(result.body);
      setCounts(result.body.counts);
      setReadAt(now);
    },
    [paging, zone, exponent],
  );

  // A query that is equal in content is not a new list: load again only when it changed. The
  // first query is the one the server already answered.
  const queryNow = useRef(query);
  queryNow.current = query;
  const queryKey = JSON.stringify(query);
  const firstKey = useRef(queryKey);
  const served = useRef(true);
  useEffect(() => {
    if (served.current && queryKey === firstKey.current) {
      served.current = false;
      return;
    }
    served.current = false;
    void load(queryNow.current);
  }, [load, queryKey]);

  // A new view, search, filter or sort is another list: the selection does not follow it. Paging
  // keeps it, so rows can be ticked on several pages. The search goes in as it is sent (an id
  // lower-cased), so the same id typed in other case keeps the ticks.
  const listKey = JSON.stringify([
    query.view,
    payoutSearchRoute(query.q),
    query.filters,
    query.sort,
    query.direction,
  ]);
  const rows = answer?.payouts;
  const pageIds = useMemo(() => rows?.map((row) => row.payoutId) ?? [], [rows]);
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
    if (!loading && focusList.current) {
      focusList.current = false;
      listTop.current?.focus();
    }
  }, [loading, answer]);

  // The API answers with a total only for page numbers: its answer, not the setting, says which
  // footer fits the rows on show.
  const mode: ListPaging = answer === null || answer.total === null ? 'prev-next' : paging;
  const pageSize = answer?.pageSize ?? query.pageSize;
  const page = mode === 'pages' ? (answer?.page ?? query.page) : query.cursors.length + 1;
  const start = (page - 1) * pageSize;

  // A page past the end (payouts left the view meanwhile) goes back one page. Once per answer:
  // the step back changes the query before the next read starts, and must not step again.
  const steppedBack = useRef<OwnPayouts | null>(null);
  useEffect(() => {
    if (answer === null || loading || failure !== null || answer.payouts.length > 0) return;
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
  const draftRoute = payoutSearchRoute(draft);
  // The hint about the typed text waits for the box to lose focus or Enter, so it is not read out
  // at the first keystroke of every search.
  const showHint = hinted && draftRoute.kind === 'not-an-id';

  const saveColumns = (next: readonly OptionalColumn[]) => {
    setColumns(next);
    writeIds(browserStorage(), storageKey, next);
  };
  const clearAll = () => reset({ q: '', filters: {}, cursors: [] });
  const withoutFilter = (field: keyof Query['filters']): Query['filters'] =>
    Object.fromEntries(Object.entries(query.filters).filter(([name]) => name !== field));

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('row-actions.copied'));
    } catch {
      toast.error(t('row-actions.copy-failed'));
    }
  }
  // Every row has the same one safe action. The API's own `open` has no panel page to open.
  const rowActions = (row: OwnPayoutRow): readonly MenuItem[] => [
    { id: 'copy-id', label: t('row-actions.copy-id'), onSelect: () => void copy(row.payoutId) },
  ];

  const chips = [
    ...(query.q === ''
      ? []
      : [
          {
            key: 'search',
            label: t('chip-search', { text: query.q }),
            onRemove: () => reset({ q: '', cursors: [] }),
          },
        ]),
    ...(query.filters.payoutOn === undefined
      ? []
      : [
          {
            key: 'payoutOn',
            label: t('chip', {
              field: t('filter.name.payoutOn'),
              value: t(`date-preset.${query.filters.payoutOn}`),
            }),
            onRemove: () => changeList({ filters: withoutFilter('payoutOn') }),
          },
        ]),
    ...(query.filters.minAmount === undefined
      ? []
      : [
          {
            key: 'minAmount',
            label: t('chip', {
              field: t('filter.name.minAmount'),
              value: stepLabel(query.filters.minAmount, currency, locale),
            }),
            onRemove: () => changeList({ filters: withoutFilter('minAmount') }),
          },
        ]),
    ...(query.filters.maxAmount === undefined
      ? []
      : [
          {
            key: 'maxAmount',
            label: t('chip', {
              field: t('filter.name.maxAmount'),
              value: stepLabel(query.filters.maxAmount, currency, locale),
            }),
            onRemove: () => changeList({ filters: withoutFilter('maxAmount') }),
          },
        ]),
  ].map((chip) => ({ ...chip, removeLabel: t('chip-remove', { filter: chip.label }) }));
  const filtered = chips.length > 0;

  const total = failure === null && mode === 'pages' ? (answer?.total ?? null) : null;
  // Previous and next lists latest first only: the sort shown is the one the API walks.
  const sortKey: Sort = mode === 'prev-next' && query.sort === 'amount' ? 'slot' : query.sort;
  const sortOrder = t(
    `sort.${sortKey}.${mode === 'prev-next' || query.direction === 'desc' ? 'first' : 'second'}`,
  );

  const skeleton = status.skeleton && failure === null;
  const firstLoadError = answer === null && failure === 'unavailable';
  const shown = answer?.payouts ?? [];
  const wholePageTicked =
    shown.length > 0 &&
    !selection.allMatching &&
    shown.every((row) => selection.selected.has(row.payoutId));
  const moreThanPage =
    mode === 'pages'
      ? (answer?.total ?? 0) > shown.length
      : answer?.nextCursor !== null || query.cursors.length > 0;

  const shopEmpty =
    answer !== null &&
    failure === null &&
    !filtered &&
    query.view === 'all' &&
    shown.length === 0 &&
    (counts === null || counts.all === 0);
  const empty = shopEmpty ? (
    <EmptyState icon="receipt" title={th('empty.title')} body={th('empty.body')} />
  ) : (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : 'receipt'}
      title={filtered ? t('empty-filtered.title') : t('empty-view.title')}
      body={filtered ? t('empty-filtered.body') : t('empty-view.body')}
      action={
        filtered ? (
          <Button variant="secondary" onClick={clearAll}>
            {t('clear-all')}
          </Button>
        ) : undefined
      }
    />
  );

  const table = (
    <div className="flex flex-col gap-4">
      {mode === 'pages' && (answer?.total ?? 0) > MAX_PAGED_ROWS ? (
        <p role="status" className="rounded-lg border border-line bg-muted px-4 py-2 text-sm">
          {t('too-many', { limit: number(MAX_PAGED_ROWS) })}
        </p>
      ) : null}
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
        <PayoutsTable
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
    <SuperList
      heading={{
        actions: (
          <PayoutsBulk
            selection={{
              ids: [...selection.selected],
              allMatching: selection.allMatching,
              total,
            }}
            query={query}
            paging={paging}
            zone={zone}
            exponent={exponent}
            columns={columns}
            readAt={readAt}
          />
        ),
      }}
      views={{
        label: t('views'),
        activeId: query.view,
        onSelect: (id) => openView(id),
        items: VIEWS.map((id) => ({
          id,
          label: `${t(`view.${id}`)}${counts === null ? '' : ` (${number(counts[id])})`}`,
        })),
        // Saved filters wait for the API: no "Manage filters" link yet.
        manage: null,
      }}
      search={{
        label: t('search.label'),
        placeholder: t('search.placeholder'),
        value: draft,
        maxLength: SEARCH_MAX,
        onChange: (value) => {
          setHinted(false);
          setDraft(value);
        },
        onBlur: () => setHinted(true),
        onSubmit: (value) => {
          setHinted(true);
          if (payoutSearchRoute(value).kind === 'not-an-id') return;
          changeList({ q: value.trim() });
        },
        extra: showHint ? (
          <p role="status" className="w-full text-sm text-fg-muted">
            {t('search.not-an-id')}
          </p>
        ) : undefined,
      }}
      filter={{
        label: t('filter.button'),
        count: filterCount(query.filters),
        panel: (close) => (
          <PayoutsFilterPanel
            filters={query.filters}
            currency={currency}
            onApply={(filters) => changeList({ filters })}
            close={close}
          />
        ),
      }}
      sort={{
        label: t('sort.button'),
        panel: () => (
          <PayoutsSortPanel
            sort={sortKey}
            direction={query.direction}
            paging={paging}
            createdShown={columns.includes('created')}
            onChange={(sort, direction) => changeList({ sort, direction })}
          />
        ),
      }}
      columns={{
        label: t('columns-button'),
        panel: (close) => (
          <PayoutsColumnsPanel columns={columns} onSave={saveColumns} close={close} />
        ),
      }}
      sortedLine={t('sorted', { field: t(`sort.field.${sortKey}`), order: sortOrder })}
      chips={
        filtered
          ? {
              chips,
              clearAll: { label: t('clear-all'), onClick: clearAll },
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
                message: th('unavailable'),
                retry: { label: tl('retry'), onClick: () => void load(query) },
              }
      }
      firstLoadError={firstLoadError}
      loading={loading}
      status={status}
      loadingLabel={t('loading')}
      slowLabel={tl('slow')}
      ready={answer !== null}
      table={table}
      pagination={
        answer !== null && answer.payouts.length > 0 && failure === null
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
                    : start + answer.payouts.length,
              maxRows: mode === 'pages' ? MAX_PAGED_ROWS : Number.MAX_SAFE_INTEGER,
              // Previous and next has no total, so no range line.
              range:
                mode === 'pages' && answer.total !== null
                  ? t('range', {
                      from: number(start + 1),
                      to: number(start + answer.payouts.length),
                      total: number(answer.total),
                    })
                  : '',
              labels: {
                rowsPerPage: t('paging.rows-per-page'),
                previous: t('paging.previous'),
                next: t('paging.next'),
                pages: t('paging.pages'),
                page: (n) => t('paging.page', { page: n }),
                narrowTitle: t('paging.narrow'),
                narrowBody: t('paging.narrow-help'),
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
  );
}
