'use client';

import {
  Banner,
  Button,
  EmailText,
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
import { SalesSavedViews } from '../sales/sales-saved-views.tsx';
import { useSavedFilters } from '../sales/sales-saved.ts';
import { SelectionBar } from '../sales/selection-bar.tsx';
import { numberFormat } from '../shared/intl.ts';
import { When } from '../shared/when.tsx';
import { areaName } from './format.ts';
import {
  DEFAULT_COLUMNS,
  DEFAULT_QUERY,
  MAX_PAGED_ROWS,
  PAGE_SIZES,
  SEARCH_MAX,
  SEARCH_MIN,
  SELECT_MAX,
  cleanColumns,
  defaultDirection,
  filterCount,
  filtersFor,
  forView,
  listBody,
  searchOf,
  searchText,
  withSearch,
  withView,
  type FilterField,
  type Filters,
  type OptionalColumn,
  type Query,
} from './seller-list-query.ts';
import {
  LIST_KEY,
  payloadOf,
  queryOf,
  somethingToSave,
  type SavedPayload,
} from './seller-list-saved.ts';
import { SellersBulk } from './sellers-bulk.tsx';
import { HealthCell, StatusCell } from './sellers-cells.tsx';
import { SellersColumnsPanel, SellersFilterPanel, SellersSortPanel } from './sellers-panels.tsx';
import {
  FILE_TABS,
  SELLER_LIST_PATH,
  STATE_TABS,
  isStateTab,
  type SellerListCounts,
  type SellerListStateCounts,
  type SellerSuperPage,
  type SellerSuperRow,
  type Tab,
} from './types.ts';

type Failure = 'denied' | 'refused' | 'too-broad' | 'unavailable';

function countOf(
  counts: SellerListCounts | null,
  stateCounts: SellerListStateCounts | null,
  tab: Tab,
): number | null {
  switch (tab) {
    case 'awaiting-review':
      return counts === null
        ? null
        : counts.awaitingReview.onboarding + counts.awaitingReview.identityChange;
    case 'incomplete':
      return counts?.incomplete ?? null;
    case 'all':
      return counts?.all ?? null;
    case 'changes-needed':
      return stateCounts?.changesNeeded ?? null;
    case 'not-approved':
      return stateCounts?.notApproved ?? null;
    case 'approved':
      return stateCounts?.approved ?? null;
    case 'suspended':
      return stateCounts?.suspended ?? null;
  }
}

/**
 * The admin seller list (SEL-14) as a super list (list 15): the awaiting-review, incomplete and
 * all views read from the seller files (search by the start of a store name or slug, filters, a
 * sort) and, for an admin who may see identity's state, four state views (newest first, no search
 * or filter); chips, columns, row selection with "select all matching", Export, the row Actions
 * menu and the footer of the Market's List paging setting. A seller's decision stays on its own
 * page, so there is no bulk action but Export. The column choice is the admin's own and lives in
 * this browser's storage. Saved filters (personal, and shared with a permission) sit beside the
 * built-in views; a saved state view is listed only for an admin who may see identity's state.
 */
export function SellersList({
  csrfToken,
  paging,
  accountId,
  marketId,
  initialTab = 'all',
}: {
  readonly csrfToken: string;
  /** The Market's "List paging" setting, Previous and next when it could not be read. */
  readonly paging: 'pages' | 'prev-next';
  readonly accountId: string;
  readonly marketId: string;
  /** Sellers opens on All, Inbox › Seller requests on the review view. */
  readonly initialTab?: Tab;
}) {
  const t = useTranslations('sellers.list');
  const ts = useTranslations('sales-lists');
  const tl = useTranslations('load');
  const locale = useLocale();
  const router = useRouter();
  const list = useSuperListQuery<Query>({
    defaultQuery: { ...DEFAULT_QUERY, view: initialTab, direction: forView(initialTab).direction },
    forView,
    withView,
    searchOf: searchText,
    withSearch,
  });
  const { query } = list;
  const stateView = isStateTab(query.view);
  const { saved, reload: loadSaved } = useSavedFilters<SavedPayload>(LIST_KEY);
  const [dialog, setDialog] = useState<'save' | 'manage' | null>(null);
  const shortSearch = list.draft.trim().length > 0 && list.draft.trim().length < SEARCH_MIN;

  const [answer, setAnswer] = useState<SellerSuperPage | null>(null);
  // The counts and areas of the last answer: they stay while a page loads or a request fails.
  const [counts, setCounts] = useState<SellerListCounts | null>(null);
  const [stateCounts, setStateCounts] = useState<SellerListStateCounts | null>(null);
  const [areas, setAreas] = useState<SellerSuperPage['areas']>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [columns, setColumns] = useState<readonly OptionalColumn[]>(DEFAULT_COLUMNS);
  const latest = useRef(0);
  const storageKey = prefsKey('admin', marketId, accountId, 'sellers-columns');
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
      const result = await callApi<SellerSuperPage>(
        'POST',
        SELLER_LIST_PATH,
        listBody(asked, paging),
        csrfToken,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        const { status, code } = result.failure;
        if (status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        setFailure(
          code === 'search.too-broad'
            ? 'too-broad'
            : status === 403
              ? 'denied'
              : code === 'validation.failed'
                ? 'refused'
                : 'unavailable',
        );
        return;
      }
      setAnswer(result.body);
      setCounts(result.body.counts);
      setStateCounts(result.body.stateCounts);
      setAreas(result.body.areas);
    },
    [paging, csrfToken],
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

  // A page past the end (sellers left the list meanwhile) goes back to the last one with rows.
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
  // The owner is identity's data: its column shows only for an admin who may see it.
  const canSeeOwner = stateCounts !== null;

  const saveColumns = (next: readonly OptionalColumn[]) => {
    setColumns(next);
    writeIds(browserStorage(), storageKey, next);
  };
  const filters = filtersFor(query.view, query.filters);
  const withoutFilter = (field: FilterField): Filters =>
    Object.fromEntries(Object.entries(filters).filter(([name]) => name !== field));
  // A saved tab that was deleted (here or by its owner) is no longer the one on show.
  const { savedId, forgetSaved, openSaved } = list;
  useEffect(() => {
    if (savedId !== null && saved !== null && !saved.items.some((item) => item.id === savedId)) {
      forgetSaved();
    }
  }, [saved, savedId, forgetSaved]);

  const clearAll = () => list.reset({ q: '', filters: {} });

  const searched = stateView ? undefined : searchOf(query.q);
  const valueLabel = (field: FilterField, value: string): string => {
    if (field === 'kind') return t(`kind.${value === 'identity-change' ? value : 'onboarding'}`);
    if (field === 'outsideArea') return t('filter.outside-area-yes');
    return areas.find((area) => area.code === value)?.name ?? areaName(value) ?? value;
  };
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
    ...(['kind', 'outsideArea', 'areaCode'] as const).flatMap((field) => {
      const value = filters[field];
      return value === undefined
        ? []
        : [
            {
              key: field,
              label: ts('chip', {
                field: t(`filter.name.${field}`),
                value: valueLabel(field, value),
              }),
              onRemove: () => list.change({ filters: withoutFilter(field) }),
            },
          ];
    }),
  ].map((chip) => ({ ...chip, removeLabel: ts('chip-remove', { filter: chip.label }) }));
  const filtered = chips.length > 0;
  // The state views need identity's access key: a saved filter on one is listed only with it.
  const stateKnown = stateCounts !== null || stateView;
  const savedTabs = (saved?.items ?? []).filter(
    (item) => stateKnown || !isStateTab(item.payload.view),
  );
  // "Save filter" is offered on a built-in view that shows something a saved filter can keep.
  const canSave = saved !== null && savedId === null && somethingToSave(query);

  const healthDown = answer?.healthUnavailable === true;
  const optionalColumn = (id: OptionalColumn): SuperColumn<SellerSuperRow> => {
    switch (id) {
      case 'owner':
        return {
          id,
          header: t('col.owner'),
          // The owner's name and address: escaped text only (personal data).
          cell: (row) =>
            row.owner === null ? (
              <span className="text-fg-muted">{t('not-given')}</span>
            ) : (
              <span className="block min-w-0">
                <span className="block wrap-anywhere text-fg">
                  {row.owner.displayName ?? t('owner-unnamed')}
                </span>
                <span className="block wrap-anywhere text-fg-muted">
                  <EmailText address={row.owner.email} />
                </span>
              </span>
            ),
        };
      case 'status':
        return {
          id,
          header: t('col.status'),
          corner: true,
          cell: (row) => <StatusCell status={row.status} kind={row.kind} />,
        };
      case 'health':
        return {
          id,
          header: t('col.health'),
          cell: (row) => <HealthCell health={row.health} unavailable={healthDown} />,
        };
      case 'area':
        return {
          id,
          header: t('col.area'),
          cell: (row) =>
            areaName(row.serviceAreaCode, row.serviceAreaName) ?? (
              <span className="text-fg-muted">{t('not-given')}</span>
            ),
        };
      case 'submitted':
        return {
          id,
          header: t('col.submitted'),
          cell: (row) => <When iso={row.submittedAt} missing={t('not-given')} />,
        };
      case 'changed':
        return {
          id,
          header: t('col.changed'),
          cell: (row) => <When iso={row.lastChangedAt} missing={t('not-given')} />,
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
  const tableColumns: SuperColumn<SellerSuperRow>[] = [
    {
      id: 'store',
      header: t('col.store'),
      primary: true,
      headClassName: 'min-w-56',
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          {/* A plain link: opening the page reads business details and is audited. */}
          <a
            href={`/sellers/${encodeURIComponent(row.sellerId)}`}
            className="font-medium text-link wrap-anywhere underline focus-visible:outline-2 focus-visible:outline-focus"
          >
            {row.storeName ?? unnamed}
          </a>
          {row.slug === null ? null : (
            <span className="text-xs text-fg-muted wrap-anywhere">{row.slug}</span>
          )}
          {row.origin === 'invitation' ? (
            <span className="text-xs text-fg-muted">{t('invited')}</span>
          ) : null}
        </div>
      ),
    },
    ...columns.filter((id) => id !== 'owner' || canSeeOwner).map(optionalColumn),
  ];

  // Exactly the actions the row names (the API decides); an id the panel does not know is
  // ignored. Rows kept after a failed refresh belong to another list: no actions.
  const rowItems = (row: SellerSuperRow): MenuItem[] =>
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
  const firstLoadError = answer === null && (failure === 'unavailable' || failure === 'refused');
  // A search that names too many sellers shows none: the rows kept belong to another search.
  const shown = failure === 'too-broad' ? [] : (answer?.items ?? []);
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
  const sortKind =
    query.sort === 'name' ? 'name' : query.view === 'awaiting-review' ? 'oldest' : 'newest';
  const sortOrder = t(
    `sort.${sortKind}.${query.direction === defaultDirection(query.sort, query.view) ? 'first' : 'second'}`,
  );

  // What a saved filter holds, in words (the save dialog shows it).
  const summary = [
    t(`tab.${query.view}`),
    ...chips.map((chip) => chip.label),
    ...(query.sort !== DEFAULT_QUERY.sort ||
    query.direction !== defaultDirection(query.sort, query.view)
      ? [ts('saved.summary-sort', { field: `${t(`sort.field.${query.sort}`)}, ${sortOrder}` })]
      : []),
  ].join(' · ');

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
          rowName={(row) => row.storeName ?? unnamed}
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
          minWidthClass="lg:min-w-240"
        />
      </div>
    </div>
  );

  return (
    <SuperList
      heading={{
        subtitle: t('intro'),
        actions: (
          <SellersBulk
            selection={{ ids: [...selection.selected], allMatching: selection.allMatching, total }}
            query={query}
            columns={columns}
            csrfToken={csrfToken}
          />
        ),
      }}
      notice={
        healthDown && failure === null ? (
          <Banner tone="info">{t('health-unavailable')}</Banner>
        ) : undefined
      }
      views={{
        label: t('tabs'),
        activeId: savedId ?? query.view,
        onSelect: (id) => {
          const filter = savedTabs.find((item) => item.id === id);
          if (filter !== undefined) {
            const next = queryOf(filter.payload);
            openSaved(id, next);
            if (isStateTab(next.view)) list.setDraft('');
            return;
          }
          list.openView(id);
          // A state view has no search box: what was typed does not wait for a later view.
          if (isStateTab(id as Tab)) list.setDraft('');
        },
        // The state views need identity's access key: without it the answer carries no counts.
        items: [
          ...(stateKnown ? [...FILE_TABS, ...STATE_TABS] : FILE_TABS).map((view) => {
            const count = countOf(counts, stateCounts, view);
            return {
              id: view,
              label: `${t(`tab.${view}`)}${count === null ? '' : ` (${number(count)})`}`,
            };
          }),
          ...savedTabs.map((item) => ({ id: item.id, label: item.name })),
        ],
        manage:
          saved === null
            ? null
            : { label: ts('saved.manage-link'), onClick: () => setDialog('manage') },
      }}
      {...(stateView
        ? {}
        : {
            search: {
              label: t('search.label'),
              placeholder: t('search.placeholder'),
              value: list.draft,
              maxLength: SEARCH_MAX,
              help: t('search.help'),
              onChange: list.setDraft,
              onSubmit: (value: string) => {
                const text = value.trim();
                if (text === '' || searchOf(text) !== undefined) list.change({ q: text });
              },
            },
            filter: {
              label: ts('filter.button'),
              count: filterCount(filters),
              panel: (close: () => void) => (
                <SellersFilterPanel
                  view={query.view}
                  filters={filters}
                  areas={areas}
                  onApply={(next) => list.change({ filters: next })}
                  close={close}
                />
              ),
            },
            sort: {
              label: ts('sort.button'),
              panel: () => (
                <SellersSortPanel
                  view={query.view}
                  sort={query.sort}
                  direction={query.direction}
                  onChange={(sort, direction) => list.change({ sort, direction })}
                />
              ),
            },
            sortedLine: t('sorted', { field: t(`sort.field.${query.sort}`), order: sortOrder }),
          })}
      columns={{
        label: ts('columns.button'),
        panel: (close) => (
          <SellersColumnsPanel columns={columns} onSave={saveColumns} close={close} />
        ),
      }}
      chips={
        filtered || shortSearch || canSave
          ? {
              chips,
              ...(filtered ? { clearAll: { label: ts('clear-all'), onClick: clearAll } } : {}),
              ...(canSave
                ? { save: { label: ts('saved.save-link'), onClick: () => setDialog('save') } }
                : {}),
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
            : failure === 'too-broad'
              ? { message: t('error.too-broad') }
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
      dialogs={
        saved === null ? undefined : (
          <SalesSavedViews
            dialog={dialog}
            onClose={() => setDialog(null)}
            listKey={LIST_KEY}
            payload={payloadOf(query)}
            summary={summary}
            saved={saved}
            csrfToken={csrfToken}
            idPrefix="sellers-list"
            onSaved={(filter) => {
              void loadSaved().then((items) => {
                // Only a filter that is in the reloaded list can be the tab on show.
                if (items?.some((item) => item.id === filter.id) === true)
                  openSaved(filter.id, queryOf(filter.payload));
              });
            }}
            onChanged={() => void loadSaved()}
          />
        )
      }
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
