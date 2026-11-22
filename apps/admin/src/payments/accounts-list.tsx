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
  useListLoading,
  useRowSelection,
  useSuperListQuery,
  writeIds,
  type MenuItem,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import type { ListPagingMode } from '../sales/cursor-paging.ts';
import { SelectionBar } from '../sales/selection-bar.tsx';
import { numberFormat } from '../shared/intl.ts';
import { DEFAULT_COLUMNS, cleanColumns, type OptionalColumn } from './list/accounts-columns.ts';
import { AccountsColumnsPanel } from './list/accounts-columns-panel.tsx';
import { AccountsBulk } from './list/accounts-export.tsx';
import { AccountsFilterPanel } from './list/accounts-filter-panel.tsx';
import {
  DEFAULT_QUERY,
  FILTER_FIELDS,
  MAX_PAGED_ROWS,
  PAGE_SIZES,
  ROW_ACTIONS,
  SEARCH_MAX,
  SEARCH_MIN,
  SELECTION_MAX,
  VIEWS,
  filterCount,
  type AccountListPage,
  type AccountListRow,
  type FilterField,
  type Filters,
  type Query,
  type View,
  type ViewCounts,
} from './list/accounts-list-types.ts';
import { accountSearchRoute, queryString } from './list/accounts-query.ts';
import { AccountsSortPanel } from './list/accounts-sort-panel.tsx';
import { AccountsTable } from './list/accounts-table.tsx';

type Failure = 'denied' | 'refused' | 'unavailable';

function failureOf(status: number, code: string): Failure {
  if (status === 403) return 'denied';
  // The API refused the query itself: asking again can never work.
  if (code === 'validation.failed') return 'refused';
  return 'unavailable';
}

const noActions = () => [];

// The query rules of the kit hook, kept at module level so they stay the same between renders.
const forView = (view: string): Query => ({ ...DEFAULT_QUERY, view: view as View });
const withView = (current: Query, view: string): Query => ({ ...current, view: view as View });
const searchOf = (current: Query): string => current.q;
// One character asks for nothing: the query keeps the search it had, and the box says so.
const withSearch = (current: Query, text: string): Query =>
  accountSearchRoute(text).kind === 'too-short' ? current : { ...current, q: text };

/**
 * The admin Seller accounts list (super list 22): the sellers' Stripe payout accounts, read-only.
 * Status views with their counts, one search box (a seller id, or a part of the store name), the
 * filter, sort and column panels with their chips, then one page of accounts with the row Actions
 * menu (Open). It follows the Market's List paging setting: page numbers with a total, or
 * Previous and Next. Rows can be selected for the one bulk action, Export. Saved filters wait for
 * their API (#1061): the views bar has no Manage link yet.
 */
export function AccountsList({
  paging,
  accountId,
  marketId,
  zone,
}: {
  /** The Market's "List paging" setting, Previous and next when it could not be read. */
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  /** The IANA zone of the table's times and of the date presets (ADR-0005). */
  readonly zone: string;
}) {
  const t = useTranslations('payments.accounts.list');
  const ta = useTranslations('payments.accounts');
  const ts = useTranslations('sales-lists');
  const tl = useTranslations('load');
  const locale = useLocale();
  const router = useRouter();
  const { query, draft, setDraft, change, goToPage, paginate, openView, reset } =
    useSuperListQuery<Query>({
      defaultQuery: DEFAULT_QUERY,
      forView,
      withView,
      searchOf,
      withSearch,
    });

  const [answer, setAnswer] = useState<AccountListPage | null>(null);
  // The view counts of the last answer that had them: they stay while a page loads or fails.
  const [counts, setCounts] = useState<ViewCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [hinted, setHinted] = useState(false);
  const [columns, setColumns] = useState<readonly OptionalColumn[]>(DEFAULT_COLUMNS);
  const latest = useRef(0);
  const storageKey = prefsKey('admin', marketId, accountId, 'seller-accounts-columns');
  // After a page change the focus moves to the top of the list, so a keyboard or screen reader
  // user starts on the new rows and not on the pager they used.
  const listTop = useRef<HTMLDivElement>(null);
  // When the rows on show were read: an export of "all matching" reads its date preset on this
  // clock, so the file covers the same window as the screen.
  const [readAt, setReadAt] = useState<Date | null>(null);
  const focusList = useRef(false);

  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  // The date presets are read at each load (and each Try again), on the clock of the list's zone.
  const load = useCallback(
    async (asked: Query) => {
      const now = new Date();
      const request = queryString(asked, { paging, zone, now });
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const result = await callApi<AccountListPage>(
        'GET',
        `payments/admin/connected-accounts?${request}`,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        const { status, code, details } = result.failure;
        if (status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        if (code === 'validation.failed') {
          // The panel never builds an invalid query: say what the API refused, once, for support.
          console.warn('payments.accounts-list-refused', details?.fields ?? []);
        }
        setFailure(failureOf(status, code));
        return;
      }
      setAnswer(result.body);
      if (result.body.counts !== null) setCounts(result.body.counts);
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
  // The search goes in as it is sent (an id lower-cased), so the same id in other case keeps ticks.
  const listKey = JSON.stringify([
    query.view,
    accountSearchRoute(query.q),
    query.filters,
    query.sort,
    query.direction,
  ]);
  const rows = answer?.items;
  const pageIds = useMemo(() => rows?.map((row) => row.sellerId) ?? [], [rows]);
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
  const mode: ListPagingMode = answer === null || answer.total === null ? 'prev-next' : paging;
  const pageSize = answer?.pageSize ?? query.pageSize;
  const page = answer?.page ?? query.page;
  const start = (page - 1) * pageSize;

  // A page past the end (accounts left the view meanwhile) goes back one page, once per answer.
  const steppedBack = useRef<AccountListPage | null>(null);
  useEffect(() => {
    if (answer === null || loading || failure !== null || answer.items.length > 0) return;
    if (steppedBack.current === answer) return;
    steppedBack.current = answer;
    if (answer.page > 1) {
      const last =
        answer.total === null ? 1 : Math.max(1, Math.ceil(answer.total / answer.pageSize));
      goToPage(Math.min(last, answer.page - 1));
    }
  }, [answer, loading, failure, goToPage]);

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const route = accountSearchRoute(query.q);
  const draftRoute = accountSearchRoute(draft);
  // The hint about the typed text waits for the box to lose focus or Enter.
  const showHint = hinted && draftRoute.kind === 'too-short';

  const saveColumns = (next: readonly OptionalColumn[]) => {
    setColumns(next);
    writeIds(browserStorage(), storageKey, next);
  };
  const clearAll = () => reset({ q: '', filters: {} });
  const withoutFilter = (field: FilterField): Filters =>
    Object.fromEntries(Object.entries(query.filters).filter(([name]) => name !== field));

  const filterValue = (field: FilterField): string | null => {
    const value = query.filters[field];
    if (value === undefined) return null;
    return field === 'created' ? ts(`date-preset.${value}`) : t(`filter.${field}.${value}`);
  };
  const chips = [
    ...(route.kind === 'id' || route.kind === 'store'
      ? [
          {
            key: 'search',
            label: t(route.kind === 'id' ? 'chip-id' : 'chip-store', { text: route.value }),
            onRemove: () => reset({ q: '' }),
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
              onRemove: () => change({ filters: withoutFilter(field) }),
            },
          ];
    }),
  ].map((chip) => ({ ...chip, removeLabel: ts('chip-remove', { filter: chip.label }) }));
  const filtered = chips.length > 0;
  const sortField = t(`sort.field.${query.sort}`);
  const sortOrder = t(`sort.${query.sort}.${query.direction === 'desc' ? 'first' : 'second'}`);
  const total = failure === null && mode === 'pages' ? (answer?.total ?? null) : null;

  // Exactly the actions the row names (the API decides per caller); one it does not know is ignored.
  const rowActions = (row: AccountListRow): readonly MenuItem[] =>
    ROW_ACTIONS.filter((action) => row.actions.includes(action)).map((action) => ({
      id: action,
      label: t('actions.open'),
      onSelect: () => router.push(`/payout-accounts/${encodeURIComponent(row.sellerId)}`),
    }));

  const empty = (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : 'wallet'}
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
        <p className="text-fg-muted">{ta('no-access')}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/">
            {ta('back-home')}
          </a>
        </p>
      </div>
    );
  }

  const skeleton = status.skeleton && failure === null;
  const firstLoadError = answer === null && failure === 'unavailable';
  const shown = answer?.items ?? [];
  const wholePageTicked =
    shown.length > 0 &&
    !selection.allMatching &&
    shown.every((row) => selection.selected.has(row.sellerId));
  const moreThanPage =
    mode === 'pages'
      ? (answer?.total ?? 0) > shown.length
      : answer?.hasNext === true || (answer?.page ?? 1) > 1;

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
        <AccountsTable
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
        info: ta('intro'),
        note: t('zone-note', { zone }),
        actions: (
          <AccountsBulk
            selection={{ ids: [...selection.selected], allMatching: selection.allMatching, total }}
            query={query}
            paging={paging}
            zone={zone}
            columns={columns}
            now={readAt ?? undefined}
          />
        ),
      }}
      notice={
        answer?.searchCapped === true && failure === null ? (
          <Banner tone="info">{t('search-capped')}</Banner>
        ) : undefined
      }
      views={{
        label: ta('tabs'),
        activeId: query.view,
        onSelect: (id) => openView(id),
        items: VIEWS.map((view) => ({
          id: view,
          label: `${view === 'all' ? ta('tab.all') : ta(`status.${view}`)}${
            counts === null ? '' : ` (${number(counts[view])})`
          }`,
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
          if (accountSearchRoute(value).kind === 'too-short') return;
          change({ q: value.trim() });
        },
        extra: showHint ? (
          <p role="status" className="w-full text-sm text-fg-muted">
            {t('search.too-short', { min: SEARCH_MIN })}
          </p>
        ) : null,
      }}
      filter={{
        label: ts('filter.button'),
        count: filterCount(query.filters),
        panel: (close) => (
          <AccountsFilterPanel
            filters={query.filters}
            onApply={(filters) => change({ filters })}
            close={close}
          />
        ),
      }}
      sort={{
        label: ts('sort.button'),
        panel: () => (
          <AccountsSortPanel
            sort={query.sort}
            direction={query.direction}
            onChange={(sort, direction) => change({ sort, direction })}
          />
        ),
      }}
      columns={{
        label: ts('columns.button'),
        panel: (close) => (
          <AccountsColumnsPanel columns={columns} onSave={saveColumns} close={close} />
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
      loadingLabel={ta('loading')}
      slowLabel={tl('slow')}
      ready={answer !== null}
      table={table}
      pagination={
        answer !== null && answer.items.length > 0 && failure === null
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
                  : answer.hasNext
                    ? page * pageSize + 1
                    : start + answer.items.length,
              maxRows: mode === 'pages' ? MAX_PAGED_ROWS : Number.MAX_SAFE_INTEGER,
              range:
                mode === 'pages' && answer.total !== null
                  ? t('range', {
                      from: number(start + 1),
                      to: number(start + answer.items.length),
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
                goToPage(target);
              },
              onPageSize: (size) => paginate({ pageSize: size }),
            }
          : null
      }
    />
  );
}
