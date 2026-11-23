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
import { stepStack } from '../sales/cursor-paging.ts';
import { SelectionBar } from '../sales/selection-bar.tsx';
import { numberFormat } from '../shared/intl.ts';
import { shortId } from '../shared/short-id.ts';
import { DEFAULT_COLUMNS, cleanColumns, type OptionalColumn } from './list/disputes-columns.ts';
import { DisputesColumnsPanel } from './list/disputes-columns-panel.tsx';
import { DisputesBulk } from './list/disputes-export.tsx';
import { DisputesFilterPanel } from './list/disputes-filter-panel.tsx';
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
  type FilterField,
  type Filters,
  type DisputeListPage,
  type DisputeListRow,
  type Query,
  type View,
  type ViewCounts,
} from './list/disputes-list-types.ts';
import { disputeSearchRoute, queryString } from './list/disputes-query.ts';
import { DisputesSortPanel } from './list/disputes-sort-panel.tsx';
import { DisputesTable } from './list/disputes-table.tsx';

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
// One character asks for nothing: the query keeps the search it had, and the box says so.
const withSearch = (current: Query, text: string): Query =>
  disputeSearchRoute(text).kind === 'too-short' ? current : { ...current, q: text, cursors: [] };

/** The `?sellerId=` of a link is only a start: removing its chip should not come back on reload. */
function forgetSellerInUrl() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('sellerId')) return;
    url.searchParams.delete('sellerId');
    window.history.replaceState(window.history.state, '', url);
  } catch {
    // The address bar is a convenience; the list works without it.
  }
}

/**
 * The admin Disputes list (super list 23): the stage views with their counts, one search box (a
 * dispute or order id, or a part of a store name), the filter, sort and column panels with their
 * chips, then one page of cases with the row Actions menu. It follows the Market's List paging
 * setting: page numbers with a total and any sort, or Previous and Next, newest opened first. Rows
 * can be selected for the one bulk action, Export. A case is decided on its own page, one seller
 * order at a time: Decide opens it. Saved filters wait for their API (#1061).
 */
export function DisputesList({
  paging,
  accountId,
  marketId,
  zone,
  initialView = 'all',
  sellerId = null,
}: {
  /** The Market's "List paging" setting, Previous and next when it could not be read. */
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  /** The IANA zone of the table's times and of the date presets (ADR-0005). */
  readonly zone: string;
  /** The view a link opens (`?status=`), All by default. */
  readonly initialView?: View;
  /** One seller's cases, from a link; shown as a chip that can be removed. */
  readonly sellerId?: string | null;
}) {
  const t = useTranslations('disputes.list');
  const tp = useTranslations('disputes');
  const ts = useTranslations('sales-lists');
  const tl = useTranslations('load');
  const locale = useLocale();
  const router = useRouter();
  const { query, draft, setDraft, change, goToPage, paginate, openView, reset } =
    useSuperListQuery<Query>({
      defaultQuery: { ...DEFAULT_QUERY, view: initialView, sellerId },
      forView,
      withView,
      searchOf,
      withSearch,
    });
  // A change of what is listed starts on the first page with no cursor.
  const changeList = (patch: Partial<Query>) => change({ cursors: [], ...patch });

  const [answer, setAnswer] = useState<DisputeListPage | null>(null);
  // The view counts of the last answer: they stay while a page loads or a read fails.
  const [counts, setCounts] = useState<ViewCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [hinted, setHinted] = useState(false);
  const [columns, setColumns] = useState<readonly OptionalColumn[]>(DEFAULT_COLUMNS);
  const latest = useRef(0);
  const storageKey = prefsKey('admin', marketId, accountId, 'disputes-columns');
  // After a page change the focus moves to the top of the list, so a keyboard or screen reader
  // user starts on the new rows and not on the pager they used.
  const listTop = useRef<HTMLDivElement>(null);
  // When the rows on show were read: an export of "all matching" reads its date preset on this
  // clock, so the file covers the same window as the screen even across midnight.
  const [readAt, setReadAt] = useState<Date | null>(null);
  const focusList = useRef(false);

  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  // The date presets are read at each load (and each Try again), on the clock of the list's zone.
  // `quiet`: read again after an action without dimming the rows or dropping them on a failure.
  const load = useCallback(
    async (asked: Query, quiet = false) => {
      const now = new Date();
      const request = queryString(asked, { paging, zone, now });
      const ticket = ++latest.current;
      if (!quiet) {
        setLoading(true);
        setFailure(null);
      }
      const result = await callApi<DisputeListPage>(
        'GET',
        `commission-payouts/admin/disputes?${request}`,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        const { status, code, details } = result.failure;
        if (status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        if (quiet) return;
        if (code === 'validation.failed') {
          // The panel never builds an invalid query: say what the API refused, once, for support.
          console.warn('disputes.list-refused', details?.fields ?? []);
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
    disputeSearchRoute(query.q),
    query.filters,
    query.sellerId,
    query.sort,
    query.direction,
  ]);
  const rows = answer?.disputes;
  const pageIds = useMemo(() => rows?.map((row) => row.disputeId) ?? [], [rows]);
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
  const page = mode === 'pages' ? (answer?.page ?? query.page) : query.cursors.length + 1;
  const start = (page - 1) * pageSize;

  // A page past the end (cases left the view meanwhile) goes back one page. Once per answer:
  // the step back changes the query before the next read starts, and must not step again.
  const steppedBack = useRef<DisputeListPage | null>(null);
  useEffect(() => {
    if (answer === null || loading || failure !== null || answer.disputes.length > 0) return;
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
  const route = disputeSearchRoute(query.q);
  const draftRoute = disputeSearchRoute(draft);
  // The hint about the typed text waits for the box to lose focus or Enter, so it is not read out
  // at the first keystroke of every search.
  const showHint = hinted && draftRoute.kind === 'too-short';

  const saveColumns = (next: readonly OptionalColumn[]) => {
    setColumns(next);
    writeIds(browserStorage(), storageKey, next);
  };
  const clearAll = () => {
    reset({ q: '', filters: {}, sellerId: null, cursors: [] });
    forgetSellerInUrl();
  };
  const withoutFilter = (field: FilterField): Filters =>
    Object.fromEntries(Object.entries(query.filters).filter(([name]) => name !== field));

  const filterValue = (field: FilterField): string | null => {
    const value = query.filters[field];
    if (value === undefined) return null;
    switch (field) {
      case 'status':
        return t(`filter.status.${query.filters.status!}`);
      case 'money':
        return t(`filter.money.${query.filters.money!}`);
      case 'evidenceDue':
        return t(`filter.due.${query.filters.evidenceDue!}`);
      case 'opened':
        return ts(`date-preset.${value}`);
    }
  };
  const chips = [
    ...(route.kind === 'id' || route.kind === 'store'
      ? [
          {
            key: 'search',
            label: t(route.kind === 'id' ? 'chip-id' : 'chip-store', { text: route.value }),
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
    ...(query.sellerId === null
      ? []
      : [
          {
            key: 'sellerId',
            label: t('chip-seller', {
              name:
                rows
                  ?.flatMap((row) => row.sellers)
                  .find((seller) => seller.sellerId === query.sellerId)
                  ?.storeName?.trim() || shortId(query.sellerId),
            }),
            onRemove: () => {
              changeList({ sellerId: null });
              forgetSellerInUrl();
            },
          },
        ]),
  ].map((chip) => ({ ...chip, removeLabel: ts('chip-remove', { filter: chip.label }) }));
  const filtered = chips.length > 0;
  // Previous and next lists newest first only: the sort is fixed there.
  const sortable = paging === 'pages';
  const sortField = t(`sort.field.${sortable ? query.sort : 'opened'}`);
  const sortOrder = t(
    `sort.${sortable ? query.sort : 'opened'}.${!sortable || query.direction === 'desc' ? 'first' : 'second'}`,
  );
  const total = failure === null && mode === 'pages' ? (answer?.total ?? null) : null;

  // Exactly the actions the row names (the API decides per caller and state), in the menu's order;
  // an id this panel does not know is ignored. Both open the case's page, where a decision is made
  // one seller order at a time.
  const rowActions = (row: DisputeListRow): readonly MenuItem[] =>
    ROW_ACTIONS.filter((action) => row.actions.includes(action)).map((action) => ({
      id: action,
      label: t(`actions.${action}`),
      onSelect: () => router.push(`/disputes/${encodeURIComponent(row.disputeId)}`),
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
        <p className="text-fg-muted">{tp('no-access')}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/">
            {tp('back-home')}
          </a>
        </p>
      </div>
    );
  }

  const skeleton = status.skeleton && failure === null;
  const firstLoadError = answer === null && failure === 'unavailable';
  const shown = answer?.disputes ?? [];
  const wholePageTicked =
    shown.length > 0 &&
    !selection.allMatching &&
    shown.every((row) => selection.selected.has(row.disputeId));
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
        <DisputesTable
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
          <DisputesBulk
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
        label: tp('filters'),
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
          if (disputeSearchRoute(value).kind === 'too-short') return;
          changeList({ q: value.trim() });
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
          <DisputesFilterPanel
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
                <DisputesSortPanel
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
          <DisputesColumnsPanel columns={columns} onSave={saveColumns} close={close} />
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
      loadingLabel={tp('loading')}
      slowLabel={tl('slow')}
      ready={answer !== null}
      table={table}
      pagination={
        answer !== null && answer.disputes.length > 0 && failure === null
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
                    : start + answer.disputes.length,
              maxRows: mode === 'pages' ? MAX_PAGED_ROWS : Number.MAX_SAFE_INTEGER,
              // Previous and next has no total, so no range line.
              range:
                mode === 'pages' && answer.total !== null
                  ? t('range', {
                      from: number(start + 1),
                      to: number(start + answer.disputes.length),
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
  );
}
