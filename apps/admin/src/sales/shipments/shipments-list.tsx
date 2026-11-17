'use client';

import {
  Banner,
  Button,
  EmptyState,
  Select,
  SuperList,
  browserStorage,
  listSkeletonRowCount,
  prefsKey,
  readIds,
  useListLoading,
  useRowSelection,
  useSuperListQuery,
  writeIds,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { shortId } from '../../shared/short-id.ts';
import { numberFormat } from '../../shared/intl.ts';
import {
  MAX_PAGED_ROWS,
  PAGE_SIZE,
  openTotal,
  pageOfStack,
  stepStack,
  type ListPagingMode,
} from '../cursor-paging.ts';
import { SelectionBar } from '../selection-bar.tsx';
import { ShipmentsBulk } from './shipments-bulk.tsx';
import { DEFAULT_COLUMNS, cleanColumns, type OptionalColumn } from './shipments-columns.ts';
import { ShipmentsColumnsPanel } from './shipments-columns-panel.tsx';
import { ShipmentsFilterPanel } from './shipments-filter-panel.tsx';
import { queryString } from './shipments-query.ts';
import { ShipmentsSortPanel } from './shipments-sort-panel.tsx';
import { useShipmentRowActions } from './shipments-row-actions.tsx';
import {
  LIST_KEY,
  payloadOf,
  queryOf,
  somethingToSave,
  type SavedPayload,
} from './shipments-saved.ts';
import { SalesSavedViews } from '../sales-saved-views.tsx';
import { useSavedFilters } from '../sales-saved.ts';
import {
  SEARCH_SCOPES,
  asksNothing,
  shipmentSearchRoute,
  type SearchScope,
} from './shipments-search.ts';
import { ShipmentsTable } from './shipments-table.tsx';
import {
  DEFAULT_QUERY,
  FILTER_FIELDS,
  TABS,
  filterCount,
  filtersOnTab,
  tabCount,
  type Filters,
  type Query,
  type ShipmentCounts,
  type ShipmentsPage,
  type Tab,
} from './shipments-types.ts';
import { SEARCH_MAX } from '../search-route.ts';

/** Rows that can be ticked one by one; "Select all matching" has no such limit. */
const SELECTION_MAX = 200;
const OPEN_ENDED = Number.MAX_SAFE_INTEGER;

type Failure = 'denied' | 'search-unavailable' | 'refused' | 'unavailable';

function failureOf(status: number, code: string): Failure {
  if (status === 403) return 'denied';
  // The API refused the query itself: asking again can never work.
  if (code === 'validation.failed') return 'refused';
  if (status === 503 && code === 'ordering.search-unavailable') return 'search-unavailable';
  return 'unavailable';
}

const noActions = () => [];

// The query rules of the kit hook, kept at module level so they stay the same between renders.
const forView = (view: string): Query => ({ ...DEFAULT_QUERY, tab: view as Tab });
const withView = (current: Query, view: string): Query => ({
  ...current,
  tab: view as Tab,
  filters: filtersOnTab(current.filters, view as Tab),
  cursors: [],
});
const searchOf = (current: Query): string => current.q;
// Text that asks for nothing (one character, a tracking reference the API would refuse) keeps the
// search the query had, and the box shows a hint.
const withSearch = (current: Query, text: string): Query =>
  asksNothing(shipmentSearchRoute(text, current.scope))
    ? current
    : { ...current, q: text, cursors: [] };

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
 * The admin Shipments list (Sales > Shipments; a super list): tabs with their counts, one search
 * box with its scope, the filter, sort and column panels with their chips, then one page of
 * shipments. It follows the Market's List paging setting: page numbers with a total (and the sort
 * menu), or Previous and next over the API's cursors, newest payment first. The column choice is
 * the admin's own and lives in this browser's storage. Rows can be selected; the Bulk action
 * button has no action yet (Export follows with its endpoint). Saved filters (the generic lists routes) add tabs after
 * the built-in ones, Save filter and Manage filters; when the route fails they are hidden.
 */
export function ShipmentsList({
  paging,
  accountId,
  marketId,
  zone,
  sellerId = null,
  csrfToken = '',
}: {
  /** The Market's "List paging" setting, Previous and next when it could not be read. */
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  /** The IANA zone of the table's times and of the date presets (ADR-0005). */
  readonly zone: string;
  /** One seller's shipments, from a link; shown as a chip that can be removed. */
  readonly sellerId?: string | null;
  /** The CSRF token of the session, for saving, renaming, moving and deleting saved filters. */
  readonly csrfToken?: string;
}) {
  const t = useTranslations('shipments');
  const ts = useTranslations('sales-lists');
  const to = useTranslations('orders');
  const tl = useTranslations('load');
  const locale = useLocale();
  const {
    query,
    draft,
    setDraft,
    savedId,
    change: changeQuery,
    goToPage,
    paginate,
    openView,
    openSaved: openSavedTab,
    forgetSaved,
    reset,
  } = useSuperListQuery<Query>({
    defaultQuery: { ...DEFAULT_QUERY, sellerId },
    forView,
    withView,
    searchOf,
    withSearch,
  });
  // Any change of what is asked for starts again at the first page (and the first cursor).
  const change = (patch: Partial<Query>) => changeQuery({ cursors: [], ...patch });

  const [answer, setAnswer] = useState<ShipmentsPage | null>(null);
  // The tab counts of the last answer: they stay while a search fails or a page loads.
  const [counts, setCounts] = useState<ShipmentCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [hinted, setHinted] = useState(false);
  const [columns, setColumns] = useState<readonly OptionalColumn[]>(DEFAULT_COLUMNS);
  const latest = useRef(0);
  const storageKey = prefsKey('admin', marketId, accountId, 'shipments-columns');
  // After a page change the focus moves to the top of the list, so a keyboard or screen reader
  // user starts on the new rows and not on the pager they used.
  const listTop = useRef<HTMLDivElement>(null);
  const focusList = useRef(false);
  // The saved filters: null until they load, and when the route cannot answer (the list then has
  // its built-in tabs only, no Save filter and no Manage filters).
  const { saved, reload: loadSaved } = useSavedFilters<SavedPayload>(LIST_KEY);
  const [dialog, setDialog] = useState<'save' | 'manage' | null>(null);

  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  // A saved tab that was deleted (here or by its owner) is no longer the one on show.
  useEffect(() => {
    if (savedId !== null && saved !== null && !saved.items.some((item) => item.id === savedId)) {
      forgetSaved();
    }
  }, [saved, savedId, forgetSaved]);

  // The date presets are read at each load (and each Try again), on the clock of the list's zone,
  // so a tab left open past midnight does not keep asking for yesterday's "Today".
  const load = useCallback(
    async (asked: Query) => {
      const request = queryString(asked, { paging, zone, now: new Date() });
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const result = await callApi<ShipmentsPage>('GET', `ordering/admin/shipments?${request}`);
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
          console.warn('shipments.list-refused', details?.fields ?? []);
        }
        setFailure(failureOf(status, code));
        return;
      }
      setAnswer(result.body);
      setCounts(result.body.counts);
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

  // A new tab, search, filter or sort is another list: the selection does not follow it. Paging
  // keeps it, so rows can be ticked on several pages.
  const listKey = JSON.stringify([
    query.tab,
    query.q,
    query.scope,
    query.filters,
    query.sellerId,
    query.sort,
    query.direction,
  ]);
  const rows = answer?.shipments;
  const pageIds = useMemo(() => rows?.map((row) => row.sellerOrderId) ?? [], [rows]);
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
  const page = mode === 'pages' ? (answer?.page ?? query.page) : pageOfStack(query.cursors);

  // A page past the end (rows were removed meanwhile) goes back to the last one that has rows.
  useEffect(() => {
    if (answer === null || loading || failure !== null || answer.shipments.length > 0) return;
    if (mode === 'pages' && answer.page !== null && answer.page > 1) {
      const last = Math.max(1, Math.ceil((answer.total ?? 0) / answer.pageSize));
      goToPage(Math.min(last, answer.page - 1));
    } else if (mode === 'prev-next' && query.cursors.length > 0) {
      paginate({ cursors: query.cursors.slice(0, -1) });
    }
  }, [answer, loading, failure, mode, query.cursors, goToPage, paginate]);

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const route = shipmentSearchRoute(query.q, query.scope);
  const draftRoute = shipmentSearchRoute(draft, query.scope);
  // The hint about the typed text waits for the box to lose focus or Enter, so it is not read out
  // at the first keystroke of every search.
  const showHint = hinted && asksNothing(draftRoute);

  const saveColumns = (next: readonly OptionalColumn[]) => {
    setColumns(next);
    writeIds(browserStorage(), storageKey, next);
  };
  const clearAll = () => {
    reset({ q: '', filters: {}, sellerId: null, cursors: [] });
    forgetSellerInUrl();
  };
  const withoutFilter = (field: (typeof FILTER_FIELDS)[number]): Filters =>
    Object.fromEntries(Object.entries(query.filters).filter(([name]) => name !== field));

  const filterValue = (field: (typeof FILTER_FIELDS)[number]): string | null => {
    const value = query.filters[field];
    if (value === undefined) return null;
    switch (field) {
      case 'deliveryMethod':
        return to(`delivery-method.${value}`);
      case 'attention':
        return t(`problem-filter.${value}`);
      case 'paid':
      case 'shipped':
        return ts(`date-preset.${value}`);
    }
  };
  const chips = [
    ...(route.kind === 'q' || route.kind === 'search'
      ? [
          {
            key: 'search',
            label: t(query.scope === 'tracking' ? 'chip-tracking' : 'chip-search', {
              text: route.value,
            }),
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
              onRemove: () => change({ filters: withoutFilter(field) }),
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
                rows?.find((row) => row.sellerId === query.sellerId)?.storeName?.trim() ||
                shortId(query.sellerId),
            }),
            onRemove: () => {
              change({ sellerId: null });
              forgetSellerInUrl();
            },
          },
        ]),
  ].map((chip) => ({ ...chip, removeLabel: ts('chip-remove', { filter: chip.label }) }));
  const filtered = chips.length > 0;
  // "Save filter" is offered on a built-in tab that shows something a saved filter can keep.
  const canSave = saved !== null && savedId === null && somethingToSave(query, paging);
  const summary = [
    t(`tab.${query.tab}`),
    ...chips
      .filter((chip) => (FILTER_FIELDS as readonly string[]).includes(chip.key))
      .map((chip) => chip.label),
    ...(paging === 'pages' &&
    (query.sort !== DEFAULT_QUERY.sort || query.direction !== DEFAULT_QUERY.direction)
      ? [
          ts('saved.summary-sort', {
            field: `${t(`sort.field.${query.sort}`)}, ${t(
              `sort.${query.sort === 'total' ? 'amount' : 'date'}.${query.direction === 'desc' ? 'first' : 'second'}`,
            )}`,
          }),
        ]
      : []),
  ].join(' · ');

  const total = failure === null && mode === 'pages' ? (answer?.total ?? null) : null;
  const rowActions = useShipmentRowActions();

  const empty = (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : 'package'}
      title={filtered ? t('empty.no-match') : t(`empty.${query.tab}.title`)}
      body={
        filtered
          ? t('empty.no-match-help')
          : t.has(`empty.${query.tab}.body`)
            ? t(`empty.${query.tab}.body`)
            : undefined
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
        <p className="text-fg-muted">{t('no-access')}</p>
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
  const searchDown = failure === 'search-unavailable';
  const shown = answer?.shipments ?? [];
  const wholePageTicked =
    shown.length > 0 &&
    !selection.allMatching &&
    shown.every((row) => selection.selected.has(row.sellerOrderId));
  const moreThanPage =
    mode === 'pages'
      ? (answer?.total ?? 0) > shown.length
      : answer?.nextCursor !== null || query.cursors.length > 0;
  const start = (page - 1) * PAGE_SIZE;
  const sortField = t(`sort.field.${query.sort}`);
  const sortOrder = t(
    `sort.${query.sort === 'total' ? 'amount' : 'date'}.${query.direction === 'desc' ? 'first' : 'second'}`,
  );

  const table = searchDown ? (
    <Banner tone="critical">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>{t('error.search-unavailable')}</span>
        <Button variant="secondary" onClick={() => void load(query)}>
          {tl('retry')}
        </Button>
      </div>
    </Banner>
  ) : (
    <div className="flex flex-col gap-4">
      {mode === 'pages' && (answer?.total ?? 0) > MAX_PAGED_ROWS ? (
        <Banner tone="info">{t('too-many', { limit: number(MAX_PAGED_ROWS) })}</Banner>
      ) : null}
      {answer?.searchScope === 'stores' && failure === null ? (
        <Banner tone="info">{t('search-stores')}</Banner>
      ) : null}
      {answer?.searchCapped === true && failure === null ? (
        <Banner tone="info">{t('search-capped')}</Banner>
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
        <ShipmentsTable
          rows={shown}
          columns={columns}
          zone={zone}
          empty={empty}
          skeletonRows={skeleton ? listSkeletonRowCount(PAGE_SIZE) : undefined}
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
        subtitle: t('intro'),
        note: to('zone-note', { zone }),
        actions: (
          <ShipmentsBulk
            selection={{ ids: [...selection.selected], allMatching: selection.allMatching, total }}
          />
        ),
      }}
      views={{
        label: t('tabs'),
        activeId: savedId ?? query.tab,
        onSelect: (id) => {
          const filter = saved?.items.find((item) => item.id === id);
          if (filter === undefined) openView(id);
          else openSavedTab(id, queryOf(filter.payload, paging));
        },
        items: [
          ...TABS.map((tab) => ({
            id: tab,
            label: `${t(`tab.${tab}`)}${counts === null ? '' : ` (${number(tabCount(counts, tab))})`}`,
            ...(tab === 'refunded' ? { title: t('tab-title.refunded') } : {}),
          })),
          ...(saved?.items ?? []).map((item) => ({ id: item.id, label: item.name })),
        ],
        manage:
          saved === null
            ? null
            : { label: ts('saved.manage-link'), onClick: () => setDialog('manage') },
      }}
      search={{
        label: t('search.label'),
        placeholder: t(`search.placeholder-${query.scope}`),
        value: draft,
        maxLength: SEARCH_MAX,
        onChange: (value) => {
          setHinted(false);
          setDraft(value);
        },
        onBlur: () => setHinted(true),
        onSubmit: (value) => {
          setHinted(true);
          if (asksNothing(shipmentSearchRoute(value, query.scope))) return;
          change({ q: value });
        },
        extra: (
          <>
            <div className="w-full sm:w-48 [&_label]:sr-only">
              <Select
                label={t('search.scope')}
                value={query.scope}
                options={SEARCH_SCOPES.map((value) => ({
                  value,
                  label: t(`search.scope-${value}`),
                }))}
                onChange={(event) => {
                  const scope = event.target.value as SearchScope;
                  // The text that fits one scope may be too short for the other: drop it then.
                  change(
                    asksNothing(shipmentSearchRoute(query.q, scope)) ? { scope, q: '' } : { scope },
                  );
                }}
              />
            </div>
            {showHint ? (
              <p role="status" className="w-full text-sm text-fg-muted">
                {t(
                  draftRoute.kind === 'invalid-tracking'
                    ? 'search.tracking-invalid'
                    : 'search.too-short',
                )}
              </p>
            ) : null}
          </>
        ),
      }}
      filter={{
        label: ts('filter.button'),
        count: filterCount(query.filters),
        panel: (close) => (
          <ShipmentsFilterPanel
            filters={query.filters}
            tab={query.tab}
            onApply={(filters) => change({ filters })}
            close={close}
          />
        ),
      }}
      {...(paging === 'pages'
        ? {
            sort: {
              label: ts('sort.button'),
              panel: () => (
                <ShipmentsSortPanel
                  sort={query.sort}
                  direction={query.direction}
                  onChange={(sort, direction) => change({ sort, direction })}
                />
              ),
            },
          }
        : {})}
      columns={{
        label: ts('columns.button'),
        panel: (close) => (
          <ShipmentsColumnsPanel columns={columns} onSave={saveColumns} close={close} />
        ),
      }}
      sortedLine={
        paging === 'pages'
          ? t('sorted', { field: sortField, order: sortOrder })
          : t('sorted-newest')
      }
      chips={
        filtered || canSave
          ? {
              chips,
              ...(filtered ? { clearAll: { label: ts('clear-all'), onClick: clearAll } } : {}),
              ...(canSave
                ? { save: { label: ts('saved.save-link'), onClick: () => setDialog('save') } }
                : {}),
              status: total === null || failure !== null ? '' : t('match', { count: total }),
            }
          : null
      }
      failure={
        failure === null || searchDown
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
      ready={answer !== null || searchDown}
      dialogs={
        saved === null ? undefined : (
          <SalesSavedViews
            dialog={dialog}
            onClose={() => setDialog(null)}
            listKey={LIST_KEY}
            payload={payloadOf(query, paging)}
            summary={summary}
            saved={saved}
            csrfToken={csrfToken}
            idPrefix="shipments"
            onSaved={(filter) => {
              void loadSaved().then((items) => {
                // Only a filter that is in the reloaded list can be the tab on show.
                if (items?.some((item) => item.id === filter.id) === true)
                  openSavedTab(filter.id, query);
              });
            }}
            onChanged={() => void loadSaved()}
          />
        )
      }
      table={table}
      pagination={
        answer !== null && answer.shipments.length > 0 && failure === null
          ? {
              mode,
              page,
              pageSize: PAGE_SIZE,
              // No page size picker in this round: one size.
              pageSizes: [PAGE_SIZE],
              // The footer is never offered a page past row 10,000: a total above it is cut here
              // (the banner above the rows says why).
              total:
                mode === 'pages'
                  ? Math.min(answer.total ?? 0, MAX_PAGED_ROWS)
                  : openTotal(page, answer.shipments.length, answer.nextCursor !== null),
              maxRows: mode === 'pages' ? MAX_PAGED_ROWS : OPEN_ENDED,
              // Previous and next has no total, so no range line.
              range:
                mode === 'pages' && answer.total !== null
                  ? to('range', {
                      from: number(start + 1),
                      to: number(start + answer.shipments.length),
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
              onPageSize: () => {},
            }
          : null
      }
    />
  );
}
