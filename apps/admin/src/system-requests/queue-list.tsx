'use client';

import {
  Banner,
  BottomSheet,
  Button,
  ColumnPickerPanel,
  EmptyState,
  FilterChip,
  IconButton,
  ListLoadingStatus,
  ListPagination,
  ListRefreshing,
  ListSortPanel,
  ListViewsBar,
  LoadError,
  NoAccess,
  Popover,
  PrevNext,
  SearchField,
  browserStorage,
  listSkeletonRowCount,
  prefsKey,
  readIds,
  useDesktop,
  useListLoading,
  useRowSelection,
  writeIds,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { numberFormat } from '../shared/intl.ts';
import { DecisionDialog, type Decide } from './decision-dialogs.tsx';
import type { Refusal } from './errors.ts';
import { QueueBulk } from './queue-bulk.tsx';
import { QueueFilterPanel } from './queue-filter-panel.tsx';
import { QueueTable, useRowMenu } from './queue-table.tsx';
import { RefusalBanner } from './refusal-banner.tsx';
import {
  BASE,
  BULK_MAX_IDS,
  DEFAULT_COLUMNS,
  DEFAULT_QUERY,
  MAX_PAGED_ROWS,
  NO_FILTERS,
  OPTIONAL_COLUMNS,
  PAGE_SIZES,
  SORTS,
  VIEWS,
  cleanColumns,
  countText,
  defaultDirection,
  filterCount,
  isView,
  queryFromSearch,
  queryString,
  rangeIsBackwards,
  searchOf,
  type Filters,
  type ListPaging,
  type OptionalColumn,
  type Query,
  type RequestPage,
  type Sort,
  type SystemRequest,
  type View,
} from './types.ts';

type Failure = 'denied' | 'unavailable';

const SEARCH_DELAY_MS = 300;

/** The areas, risks and statuses a chip names. */
type ListFilter = 'area' | 'risk' | 'status';

/**
 * The System requests queue, a super list (rule 14): the seven views with their counts, search,
 * the filter panel with removable chips, sort, the column picker, row selection with "select all
 * matching", bulk approve, page numbers with the total or Previous and next as the Market's List
 * paging setting says, and the phone layout (cards, bottom sheets). The admin's last view and
 * column choice live in this browser's storage; the address keeps the rest, so a request page can
 * link back to the same list. Saved filters and export wait for the kit's System requests routes.
 */
export function QueueList({
  accountId,
  marketId,
  csrfToken,
  zone,
  paging,
  initialSearch,
}: {
  readonly accountId: string;
  readonly marketId: string;
  readonly csrfToken: string;
  /** The admin's IANA zone: the days of the filter and the times of the table. */
  readonly zone: string;
  readonly paging: ListPaging;
  /** The query string of the address (a deep link from a setting page, or the queue's own). */
  readonly initialSearch: string;
}) {
  const t = useTranslations('system-requests');
  const tl = useTranslations('load');
  const locale = useLocale();
  const desktop = useDesktop();
  const [query, setQuery] = useState<Query>(() => queryFromSearch(initialSearch));
  const [draft, setDraft] = useState(query.q);
  const [cursors, setCursors] = useState<readonly (string | null)[]>([null]);
  const [answer, setAnswer] = useState<RequestPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [ready, setReady] = useState(false);
  const [columns, setColumns] = useState<readonly OptionalColumn[]>(DEFAULT_COLUMNS);
  const [sheet, setSheet] = useState<'filter' | 'sort' | null>(null);
  const [deciding, setDeciding] = useState<{ row: SystemRequest; kind: Decide } | null>(null);
  const [refusal, setRefusal] = useState<{
    row: SystemRequest;
    kind: Decide;
    refusal: Refusal;
  } | null>(null);
  const latest = useRef(0);
  const known = useRef(new Map<string, SystemRequest>());
  // True until the first answer when nothing says which view to open: Needs my review, or All
  // open when nothing waits for this admin.
  const auto = useRef(false);
  const listTop = useRef<HTMLDivElement>(null);
  const focusList = useRef(false);
  const columnsKey = prefsKey('admin', marketId, accountId, 'system-requests-columns');
  const viewKey = prefsKey('admin', marketId, accountId, 'system-requests-view');
  const queryKey = prefsKey('admin', marketId, accountId, 'system-requests-query');
  const cursor = cursors[cursors.length - 1] ?? null;
  const backwards = rangeIsBackwards(query.filters);

  // The admin's own choices from this browser: the columns, and the view last used (unless the
  // address names one).
  useEffect(() => {
    const store = browserStorage();
    setColumns(cleanColumns(readIds(store, columnsKey)));
    if (!new URLSearchParams(initialSearch).has('view')) {
      const stored = readIds(store, viewKey)?.[0] ?? null;
      if (isView(stored)) setQuery((current) => ({ ...current, view: stored }));
      else auto.current = true;
    }
    setReady(true);
    // Once, on mount.
  }, []);

  const load = useCallback(
    async (next: Query, after: string | null) => {
      if (rangeIsBackwards(next.filters)) {
        latest.current += 1;
        setAnswer(null);
        setLoading(false);
        return;
      }
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const result = await callApi<RequestPage>(
        'GET',
        `${BASE}/requests?${queryString(next, zone, paging, after)}`,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        const { failure: problem } = result;
        if (problem.status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        if (problem.code === 'validation.failed') {
          // A query the API refused: back to the defaults of the view, with a word about it.
          setInvalid(true);
          setDraft('');
          setCursors([null]);
          setQuery({ ...DEFAULT_QUERY, view: next.view });
          return;
        }
        setFailure(problem.status === 403 ? 'denied' : 'unavailable');
        return;
      }
      for (const row of result.body.rows) known.current.set(row.id, row);
      if (auto.current) {
        auto.current = false;
        if (next.view === 'needs-my-review' && result.body.counts['needs-my-review'] === 0) {
          setQuery((current) => ({ ...current, view: 'all-open' }));
        }
      }
      setAnswer(result.body);
    },
    [zone, paging],
  );

  useEffect(() => {
    if (ready) void load(query, cursor);
  }, [ready, load, query, cursor]);

  // The address follows the list, and the page of a request links back to it.
  useEffect(() => {
    if (!ready) return;
    const search = searchOf(query);
    window.history.replaceState(null, '', `?${search}`);
    writeIds(browserStorage(), queryKey, [search]);
  }, [ready, query, queryKey]);

  // Typing searches after a short pause; Enter does not wait.
  useEffect(() => {
    if (draft.trim() === query.q) return undefined;
    const timer = setTimeout(() => change({ q: draft.trim() }), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, query.q]);

  // A new view, search, filter or sort is another list: the selection does not follow it. Paging
  // keeps it, so rows can be ticked on several pages.
  const listKey = JSON.stringify([query.view, query.q, query.filters, query.sort, query.direction]);
  const rows = useMemo(() => answer?.rows ?? [], [answer]);
  const pageIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const selection = useRowSelection(pageIds, BULK_MAX_IDS, listKey);
  const status = useListLoading(loading, answer !== null);
  useEffect(() => {
    if (!status.stalled) return;
    latest.current += 1;
    setLoading(false);
    setFailure('unavailable');
  }, [status.stalled]);
  const firstLoadError = answer === null && failure === 'unavailable';
  const skeleton = status.skeleton && failure === null;

  /** Any change of what is asked for starts again at the first page. */
  function change(patch: Partial<Query>) {
    setCursors([null]);
    setQuery((current) => ({ ...current, page: 1, ...patch }));
  }
  const withFilters = (patch: Partial<Filters>) =>
    change({ filters: { ...query.filters, ...patch } });
  const clearAll = () => {
    setDraft('');
    change({ q: '', filters: NO_FILTERS });
  };
  const goToPage = (page: number) => {
    focusList.current = true;
    setQuery((current) => ({ ...current, page }));
  };
  const reload = () => void load(query, cursor);

  useEffect(() => {
    if (!loading && focusList.current) {
      focusList.current = false;
      listTop.current?.focus();
    }
  }, [loading, answer]);

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const counts = answer?.counts ?? null;
  const filtered = query.q !== '' || filterCount(query.filters) > 0;
  const total = answer?.total ?? null;

  // The chips: one per value, then the applied days, overdue and the deep-link subject.
  const day = (value: string) => {
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
          date,
        );
  };
  const chips: { readonly id: string; readonly label: string; readonly remove: () => void }[] = [
    ...(['area', 'risk', 'status'] as const).flatMap((field: ListFilter) =>
      query.filters[field].map((value) => ({
        id: `${field}:${value}`,
        label: t('chip', { field: t(`filter.name.${field}`), value: t(`${field}.${value}`) }),
        remove: () =>
          withFilters({ [field]: query.filters[field].filter((entry) => entry !== value) }),
      })),
    ),
    ...(query.filters.from === '' && query.filters.to === ''
      ? []
      : [
          {
            id: 'applied',
            label:
              query.filters.from !== '' && query.filters.to !== ''
                ? t('chip-applied-between', {
                    from: day(query.filters.from),
                    to: day(query.filters.to),
                  })
                : query.filters.from !== ''
                  ? t('chip-applied-from', { from: day(query.filters.from) })
                  : t('chip-applied-to', { to: day(query.filters.to) }),
            remove: () => withFilters({ from: '', to: '' }),
          },
        ]),
    ...(query.filters.overdue
      ? [
          {
            id: 'overdue',
            label: t('filter.overdue-only'),
            remove: () => withFilters({ overdue: false }),
          },
        ]
      : []),
    ...(query.filters.subjectKind === ''
      ? []
      : [
          {
            id: 'subject',
            label: t('chip-subject', {
              ref:
                query.filters.subjectRef === ''
                  ? query.filters.subjectKind
                  : query.filters.subjectRef,
            }),
            remove: () => withFilters({ subjectKind: '', subjectRef: '' }),
          },
        ]),
  ];

  const menuOf = useRowMenu((row, kind) => setDeciding({ row, kind }));
  const filterTotal = filterCount(query.filters);

  const filterPanel = (close: () => void) => (
    <QueueFilterPanel
      // A new panel when the filters change from outside (a chip removed): its draft starts over.
      key={JSON.stringify(query.filters)}
      filters={query.filters}
      view={query.view}
      onApply={(filters) => change({ filters })}
      close={close}
    />
  );
  const sortPanel = (
    <ListSortPanel
      sort={query.sort}
      direction={query.direction}
      fields={SORTS.map((value) => ({ id: value, label: t(`sort.field.${value}`) }))}
      defaultDirection={(value) => defaultDirection(value as Sort)}
      orderLabels={(value) => [t(`sort.${value}.first`), t(`sort.${value}.second`)]}
      labels={{ by: t('sort.by'), order: t('sort.order') }}
      name="system-requests-sort"
      onChange={(sort, direction) => change({ sort: sort as Sort, direction })}
    />
  );

  const emptyTitle = filtered
    ? t('empty.filtered.title')
    : query.view === 'needs-my-review'
      ? t('empty.needs-my-review.title')
      : t(`empty.${query.view}.title`);
  const emptyBody = filtered
    ? undefined
    : t.has(`empty.${query.view}.body`)
      ? t(`empty.${query.view}.body`)
      : undefined;
  const empty = (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : query.view === 'overdue' ? 'check' : 'inbox'}
      title={emptyTitle}
      body={emptyBody}
      action={
        filtered ? (
          <Button variant="secondary" onClick={clearAll}>
            {t('filter.clear')}
          </Button>
        ) : undefined
      }
    />
  );

  if (failure === 'denied') {
    return (
      <NoAccess
        title={t('no-access')}
        body={t('no-access-body')}
        backHref="/"
        backLabel={t('back-home')}
      />
    );
  }

  const start = answer === null || answer.page === null ? 0 : (answer.page - 1) * answer.pageSize;
  const matchingTotal = counts === null ? 0 : counts[query.view];
  const pageFullyTicked = rows.length > 0 && rows.every((row) => selection.selected.has(row.id));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-fg-muted">{t('subtitle')}</p>
      {invalid ? <Banner tone="attention">{t('invalid-filters')}</Banner> : null}
      {refusal === null ? null : (
        <RefusalBanner
          refusal={refusal.refusal}
          reviewPermission={refusal.row.reviewPermission}
          prefix={refusal.row.displayNumber}
          onRetry={() => {
            setDeciding({ row: refusal.row, kind: refusal.kind });
            setRefusal(null);
          }}
        />
      )}
      <ListViewsBar
        label={t('views')}
        activeId={query.view}
        onSelect={(id) => {
          const view = id as View;
          writeIds(browserStorage(), viewKey, [view]);
          auto.current = false;
          change({ view });
        }}
        items={VIEWS.map((view) => ({
          id: view,
          label: `${t(`view.${view}`)}${counts === null ? '' : ` (${countText(counts[view], number)})`}`,
          ...(view === 'overdue' ? { tone: 'critical' as const } : {}),
        }))}
        manage={null}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SearchField
          label={t('search.label')}
          placeholder={t('search.placeholder')}
          value={draft}
          maxLength={100}
          className="w-full min-w-0 sm:min-w-64 sm:max-w-110 sm:flex-1"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') change({ q: draft.trim() });
          }}
        />
        <fieldset disabled={skeleton} className="flex min-w-0 items-center gap-2">
          {desktop ? (
            <>
              <Popover label={t('filter.button')} icon="sliders" count={filterTotal} width="lg">
                {filterPanel}
              </Popover>
              <Popover label={t('sort.button')} icon="arrow-down" width="sm">
                {() => sortPanel}
              </Popover>
              <Popover label={t('columns.button')} icon="columns" width="md">
                {(close) => (
                  <ColumnPickerPanel
                    all={OPTIONAL_COLUMNS}
                    fixed={['request', 'area', 'risk', 'status'].map((id) => ({
                      id,
                      label: t(`col.${id}`),
                    }))}
                    shown={columns}
                    defaults={DEFAULT_COLUMNS}
                    labelOf={(column) => t(`col.${column}`)}
                    labels={{
                      title: t('columns.title'),
                      help: t('columns.help'),
                      always: t('columns.always'),
                      up: (column) => t('columns.up', { column }),
                      down: (column) => t('columns.down', { column }),
                      reset: t('columns.reset'),
                      save: t('columns.save'),
                    }}
                    onSave={(next) => {
                      const chosen = cleanColumns(next);
                      setColumns(chosen);
                      writeIds(browserStorage(), columnsKey, chosen);
                    }}
                    close={close}
                  />
                )}
              </Popover>
            </>
          ) : (
            <>
              <IconButton
                icon="sliders"
                label={
                  filterTotal > 0 ? `${t('filter.button')} (${filterTotal})` : t('filter.button')
                }
                aria-haspopup="dialog"
                onClick={() => setSheet('filter')}
              />
              <IconButton
                icon="arrow-down"
                label={t('sort.button')}
                aria-haspopup="dialog"
                onClick={() => setSheet('sort')}
              />
            </>
          )}
          <span title={t('export.hint')} className="inline-flex">
            <Button variant="secondary" disabled aria-describedby="sr-export-hint">
              {t('export.button')}
            </Button>
            <span id="sr-export-hint" className="sr-only">
              {t('export.hint')}
            </span>
          </span>
        </fieldset>
        <p className="text-sm text-fg-muted sm:ms-auto">
          {t('sorted', {
            field: t(`sort.field.${query.sort}`),
            order: t(
              `sort.${query.sort}.${query.direction === defaultDirection(query.sort) ? 'first' : 'second'}`,
            ),
          })}
        </p>
      </div>
      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <FilterChip
              key={chip.id}
              label={chip.label}
              removeLabel={t('chip-remove', { filter: chip.label })}
              onRemove={chip.remove}
            />
          ))}
          <Button variant="link" className="min-h-(--mp-size-control-sm)" onClick={clearAll}>
            {t('filter.clear-all')}
          </Button>
        </div>
      ) : null}
      {failure === null || firstLoadError ? null : (
        <Banner tone="critical">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{t('error.unavailable')}</span>
            <Button variant="secondary" onClick={reload}>
              {tl('retry')}
            </Button>
          </div>
        </Banner>
      )}
      {firstLoadError ? (
        <LoadError
          className=""
          message={t('error.unavailable')}
          retryLabel={tl('retry')}
          onRetry={reload}
        />
      ) : null}
      {skeleton || (answer !== null && !firstLoadError) || (backwards && !loading) ? (
        <div ref={listTop} tabIndex={-1} className="outline-none">
          <ListRefreshing refreshing={status.refreshing} busy={loading}>
            <QueueTable
              rows={rows}
              columns={columns}
              zone={zone}
              accountId={accountId}
              empty={
                backwards ? (
                  <EmptyState size="compact" icon="search" title={t('empty.filtered.title')} />
                ) : (
                  empty
                )
              }
              skeletonRows={skeleton ? listSkeletonRowCount(query.pageSize) : undefined}
              menuOf={menuOf}
              selection={{
                selected: selection.selected,
                allMatching: selection.allMatching,
                full: selection.full,
                onToggle: selection.toggleRow,
                onTogglePage: selection.togglePage,
              }}
            />
          </ListRefreshing>
        </div>
      ) : null}
      {loading && answer === null && !firstLoadError ? (
        <ListLoadingStatus label={t('loading')} slow={status.slow} slowLabel={tl('slow')} />
      ) : null}
      {answer !== null && !skeleton && rows.length > 0 ? (
        paging === 'pages' && total !== null ? (
          <ListPagination
            mode="pages"
            page={answer.page ?? 1}
            pageSize={answer.pageSize}
            pageSizes={PAGE_SIZES}
            total={total}
            maxRows={MAX_PAGED_ROWS}
            range={t('range', {
              from: number(start + 1),
              to: number(start + rows.length),
              total: countText(total, number),
            })}
            labels={{
              rowsPerPage: t('paging.rows-per-page'),
              previous: t('paging.previous'),
              next: t('paging.next'),
              pages: t('paging.pages'),
              page: (page) => t('paging.page', { page }),
              narrowTitle: t('paging.narrow-title'),
              narrowBody: t('paging.narrow-body'),
            }}
            disabled={loading}
            onPage={goToPage}
            onPageSize={(pageSize) => change({ pageSize })}
          />
        ) : (
          <PrevNext
            hasPrevious={cursors.length > 1}
            hasNext={answer.nextCursor !== null}
            disabled={loading}
            onPrevious={() => {
              focusList.current = true;
              setCursors((current) => current.slice(0, -1));
            }}
            onNext={() => {
              if (answer.nextCursor === null) return;
              focusList.current = true;
              const next = answer.nextCursor;
              setCursors((current) => [...current, next]);
            }}
            labels={{
              nav: t('paging.pages'),
              previous: t('paging.previous'),
              next: t('paging.next'),
            }}
          />
        )
      ) : null}
      <QueueBulk
        ids={[...selection.selected]}
        allMatching={selection.allMatching}
        matchingTotal={matchingTotal}
        rowOf={(id) => known.current.get(id)}
        query={query}
        zone={zone}
        csrfToken={csrfToken}
        canOfferAll={
          pageFullyTicked && !selection.allMatching && matchingTotal > selection.selected.size
        }
        onSelectAll={selection.selectAllMatching}
        onClear={selection.clear}
        onDeselect={(ids) => ids.forEach((id) => selection.toggleRow(id))}
        onKeepOnly={(ids) => {
          selection.clear();
          ids.forEach((id) => selection.toggleRow(id));
        }}
        onChanged={reload}
      />
      <DecisionDialog
        kind={deciding?.kind ?? null}
        request={deciding?.row ?? null}
        csrfToken={csrfToken}
        onClose={() => setDeciding(null)}
        onDecided={() => {
          setDeciding(null);
          setRefusal(null);
          reload();
        }}
        onRefused={(next, kind) => {
          const row = deciding?.row;
          setDeciding(null);
          if (row !== undefined) setRefusal({ row, kind, refusal: next });
          reload();
        }}
      />
      <BottomSheet
        open={!desktop && sheet === 'filter'}
        title={t('filter.title')}
        closeLabel={t('close')}
        onClose={() => setSheet(null)}
      >
        <div className="[&_h2]:sr-only">{filterPanel(() => setSheet(null))}</div>
      </BottomSheet>
      <BottomSheet
        open={!desktop && sheet === 'sort'}
        title={t('sort.button')}
        closeLabel={t('close')}
        onClose={() => setSheet(null)}
      >
        {sortPanel}
      </BottomSheet>
    </div>
  );
}
