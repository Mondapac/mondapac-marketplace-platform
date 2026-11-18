'use client';

import {
  Badge,
  Banner,
  Button,
  EmptyState,
  SuperList,
  SuperTable,
  browserStorage,
  listSkeletonRowCount,
  prefsKey,
  readIds,
  useListLoading,
  useRowSelection,
  useSuperListQuery,
  writeIds,
  type MenuItem,
  type SuperColumn,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { numberFormat } from '../shared/intl.ts';
import { SelectionBar } from '../sales/selection-bar.tsx';
import { HealthQueueBulk } from './health-queue-bulk.tsx';
import { HealthColumnsPanel, HealthFilterPanel, HealthSortPanel } from './health-queue-panels.tsx';
import {
  DEFAULT_COLUMNS,
  DEFAULT_QUERY,
  FILTER_FIELDS,
  MAX_PAGED_ROWS,
  PAGE_SIZES,
  SEARCH_MAX,
  SEARCH_MIN,
  SELECT_MAX,
  cleanColumns,
  defaultDirection,
  filterCount,
  queryString,
  searchOf,
  type FilterField,
  type Filters,
  type OptionalColumn,
  type Query,
} from './health-list-query.ts';
import {
  HEALTH_METRICS,
  HEALTH_QUEUE_LIST_PATH,
  VIEWS,
  type HealthQueuePage,
  type HealthQueueRow,
  type View,
} from './health-types.ts';

type Failure = 'denied' | 'refused' | 'unavailable';

/** The measured day is a calendar date (UTC night), so it shows as a date and no time of day. */
const dayOf = (day: string, locale: string): string => {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? '-'
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
};

const known = (metric: string): (typeof HEALTH_METRICS)[number] | null =>
  (HEALTH_METRICS as readonly string[]).includes(metric)
    ? (metric as (typeof HEALTH_METRICS)[number])
    : null;

const rowName = (row: HealthQueueRow, unnamed: string): string => row.storeName ?? unnamed;

// The query rules of the kit hook, at module level so they stay the same between renders.
const forView = (view: string): Query => ({ ...DEFAULT_QUERY, view: view as View });
const withView = (current: Query, view: string): Query => ({ ...current, view: view as View });
const searchText = (current: Query): string => current.q;
// Text that asks for nothing (one character) keeps the search the query had; the box says why.
const withSearch = (current: Query, q: string): Query =>
  q !== '' && searchOf(q) === undefined ? current : { ...current, q };

/**
 * The sellers whose latest stored health is unhealthy, as a super list (list 16): one view per
 * health measure with its count, search by the start of a store name or slug, a score range,
 * sort, columns, chips, row selection with "select all matching", Export, the row Actions menu
 * and the footer of the Market's List paging setting. It only informs: nothing here acts on a
 * seller, so there is no bulk action, and the one row action is Open (the seller's file). The
 * queue holds at most 200 sellers; when more were unhealthy a notice says so. The column choice
 * is the admin's own and lives in this browser's storage.
 */
export function HealthQueue({
  paging,
  accountId,
  marketId,
}: {
  /** The Market's "List paging" setting, Previous and next when it could not be read. */
  readonly paging: 'pages' | 'prev-next';
  readonly accountId: string;
  readonly marketId: string;
}) {
  const t = useTranslations('sellers.health-queue');
  const ts = useTranslations('sales-lists');
  const tl = useTranslations('load');
  const locale = useLocale();
  const router = useRouter();
  const list = useSuperListQuery<Query>({
    defaultQuery: DEFAULT_QUERY,
    forView,
    withView,
    searchOf: searchText,
    withSearch,
  });
  const { query } = list;
  const shortSearch = list.draft.trim().length > 0 && list.draft.trim().length < SEARCH_MIN;

  const [answer, setAnswer] = useState<HealthQueuePage | null>(null);
  // The view counts of the last answer: they stay while a page loads or a request fails.
  const [counts, setCounts] = useState<HealthQueuePage['counts'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [columns, setColumns] = useState<readonly OptionalColumn[]>(DEFAULT_COLUMNS);
  const latest = useRef(0);
  const storageKey = prefsKey('admin', marketId, accountId, 'seller-health-columns');
  // After a page change the focus moves to the top of the list, so a keyboard or screen reader
  // user starts on the new rows and not on the pager they used.
  const listTop = useRef<HTMLDivElement>(null);
  const focusList = useRef(false);

  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  const load = useCallback(
    async (asked: Query) => {
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const result = await callApi<HealthQueuePage>(
        'GET',
        `${HEALTH_QUEUE_LIST_PATH}?${queryString(asked, paging)}`,
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
          console.warn('seller-health.list-refused', details?.fields ?? []);
        }
        setFailure(
          status === 403 ? 'denied' : code === 'validation.failed' ? 'refused' : 'unavailable',
        );
        return;
      }
      setAnswer(result.body);
      setCounts(result.body.counts);
    },
    [paging],
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
  const selectionKey = JSON.stringify([
    query.view,
    searchOf(query.q),
    query.filters,
    query.sort,
    query.direction,
  ]);
  const rows = answer?.items;
  const pageIds = useMemo(() => rows?.map((row) => row.sellerId) ?? [], [rows]);
  const selection = useRowSelection(pageIds, SELECT_MAX, selectionKey);
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
  const mode: 'pages' | 'prev-next' =
    answer === null || answer.total === null ? 'prev-next' : paging;

  // A page past the end (sellers left the queue meanwhile) goes back to the last one with rows.
  useEffect(() => {
    if (answer === null || loading || failure !== null || answer.items.length > 0) return;
    if (answer.page > 1) {
      const last =
        answer.total === null ? answer.page - 1 : Math.ceil(answer.total / answer.pageSize);
      list.goToPage(Math.max(1, Math.min(last, answer.page - 1)));
    }
  }, [answer, loading, failure, list]);

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const unnamed = t('unnamed');
  const total = failure === null && mode === 'pages' ? (answer?.total ?? null) : null;

  const saveColumns = (next: readonly OptionalColumn[]) => {
    setColumns(next);
    writeIds(browserStorage(), storageKey, next);
  };
  const withoutFilter = (field: FilterField): Filters =>
    Object.fromEntries(Object.entries(query.filters).filter(([name]) => name !== field));
  const clearAll = () => list.reset({ q: '', filters: {} });

  const searched = searchOf(query.q);
  const chips = [
    ...(searched === undefined
      ? []
      : [
          {
            key: 'search',
            label: t('chip-search', { text: searched }),
            onRemove: () => list.reset({ q: '' }),
          },
        ]),
    ...FILTER_FIELDS.flatMap((field) => {
      const value = query.filters[field];
      return value === undefined
        ? []
        : [
            {
              key: field,
              label: ts('chip', { field: t(`filter.chip.${field}`), value }),
              onRemove: () => list.change({ filters: withoutFilter(field) }),
            },
          ];
    }),
  ].map((chip) => ({ ...chip, removeLabel: ts('chip-remove', { filter: chip.label }) }));
  const filtered = chips.length > 0;

  const optionalColumn = (id: OptionalColumn): SuperColumn<HealthQueueRow> => {
    switch (id) {
      case 'score':
        return {
          id,
          header: t('col.score'),
          corner: true,
          cell: (row) => (
            <Badge tone="critical">
              {t('unhealthy')} · {row.score}
            </Badge>
          ),
        };
      case 'lowest':
        return {
          id,
          header: t('col.lowest'),
          cell: (row) => {
            const metric = known(row.lowestMetric);
            return metric === null ? '-' : t(`metric.${metric}`);
          },
        };
      case 'measured':
        return {
          id,
          header: t('col.measured'),
          cell: (row) => <time dateTime={row.day}>{dayOf(row.day, locale)}</time>,
        };
      case 'seller-id':
        return {
          id,
          header: t('col.seller-id'),
          cell: (row) => (
            <span className="font-mono text-sm wrap-anywhere" title={row.sellerId}>
              {row.sellerId}
            </span>
          ),
        };
    }
  };
  const tableColumns: SuperColumn<HealthQueueRow>[] = [
    {
      id: 'seller',
      header: t('col.seller'),
      primary: true,
      headClassName: 'min-w-56',
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <a
            href={`/sellers/${encodeURIComponent(row.sellerId)}`}
            className="font-medium text-link wrap-anywhere underline focus-visible:outline-2 focus-visible:outline-focus"
          >
            {row.storeName ?? unnamed}
          </a>
          {row.slug === null ? null : (
            <span className="text-fg-muted wrap-anywhere">{row.slug}</span>
          )}
        </div>
      ),
    },
    ...columns.map(optionalColumn),
  ];

  // Exactly the actions the row names (the API decides), in a fixed order; an id the panel does
  // not know is ignored. Rows kept after a failed refresh belong to another list: no actions.
  const rowItems = (row: HealthQueueRow): MenuItem[] =>
    failure !== null || !row.actions.includes('open')
      ? []
      : [
          {
            id: 'open',
            label: t('row.open'),
            onSelect: () => router.push(`/sellers/${encodeURIComponent(row.sellerId)}`),
          },
        ];

  const empty = (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : 'store'}
      title={
        filtered
          ? t('empty.no-match')
          : counts !== null && counts.all > 0
            ? t(`empty.view.${query.view}`)
            : t('empty.title')
      }
      body={
        filtered
          ? t('empty.no-match-help')
          : counts !== null && counts.all > 0
            ? undefined
            : t('empty.body')
      }
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
        <p className="text-fg-muted">{t('no-access.body')}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/">
            {t('back-home')}
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
  const pageSize = answer?.pageSize ?? query.pageSize;
  const page = answer?.page ?? query.page;
  const start = (page - 1) * pageSize;
  const sortField = t(`sort.field.${query.sort}`);
  const kind = query.sort === 'name' ? 'name' : query.sort === 'day' ? 'date' : 'score';
  const sortOrder = t(
    `sort.${kind}.${query.direction === defaultDirection(query.sort) ? 'first' : 'second'}`,
  );

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
        <SuperTable
          caption={t('title')}
          rows={shown}
          rowId={(row) => row.sellerId}
          rowName={(row) => rowName(row, unnamed)}
          columns={tableColumns}
          selection={{
            state: selection,
            labels: {
              page: t('select.page'),
              pageShort: t('select.page-short'),
              row: (name) => t('select.row', { name }),
            },
          }}
          actions={{
            header: t('col.actions'),
            label: (name) => t('row.menu', { name }),
            items: rowItems,
          }}
          empty={empty}
          skeletonRows={skeleton ? listSkeletonRowCount(query.pageSize) : undefined}
          minWidthClass="lg:min-w-200"
        />
      </div>
    </div>
  );

  return (
    <SuperList
      heading={{
        subtitle: t('intro'),
        note: t('informs'),
        actions: (
          <HealthQueueBulk
            selection={{ ids: [...selection.selected], allMatching: selection.allMatching, total }}
            query={query}
            columns={columns}
          />
        ),
      }}
      notice={
        answer?.truncated === true && failure === null ? (
          <Banner tone="info">{t('truncated')}</Banner>
        ) : undefined
      }
      views={{
        label: t('views'),
        activeId: query.view,
        onSelect: (id) => list.openView(id),
        items: VIEWS.map((view) => ({
          id: view,
          label: `${view === 'all' ? t('view.all') : t(`metric.${view}`)}${
            counts === null ? '' : ` (${number(counts[view])})`
          }`,
        })),
        manage: null,
      }}
      search={{
        label: t('search.label'),
        placeholder: t('search.placeholder'),
        value: list.draft,
        maxLength: SEARCH_MAX,
        help: t('search.help'),
        onChange: list.setDraft,
        onSubmit: (value) => {
          const text = value.trim();
          if (text === '' || searchOf(text) !== undefined) list.change({ q: text });
        },
      }}
      filter={{
        label: ts('filter.button'),
        count: filterCount(query.filters),
        panel: (close) => (
          <HealthFilterPanel
            filters={query.filters}
            onApply={(filters) => list.change({ filters })}
            close={close}
          />
        ),
      }}
      sort={{
        label: ts('sort.button'),
        panel: () => (
          <HealthSortPanel
            sort={query.sort}
            direction={query.direction}
            onChange={(sort, direction) => list.change({ sort, direction })}
          />
        ),
      }}
      columns={{
        label: ts('columns.button'),
        panel: (close) => (
          <HealthColumnsPanel columns={columns} onSave={saveColumns} close={close} />
        ),
      }}
      sortedLine={t('sorted', { field: sortField, order: sortOrder })}
      chips={
        filtered || shortSearch
          ? {
              chips,
              ...(filtered ? { clearAll: { label: ts('clear-all'), onClick: clearAll } } : {}),
              status: shortSearch
                ? t('search.too-short', { min: SEARCH_MIN })
                : total === null || failure !== null
                  ? ''
                  : t('match', { count: total }),
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
      loadingLabel={t('loading')}
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
              // Previous and next has no total, so no range line.
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
                list.goToPage(target);
              },
              onPageSize: (size) => list.paginate({ pageSize: size }),
            }
          : null
      }
    />
  );
}
