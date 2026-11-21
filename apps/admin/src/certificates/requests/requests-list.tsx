'use client';

import {
  Banner,
  Button,
  EmptyState,
  NoAccess,
  SuperList,
  browserStorage,
  listSkeletonRowCount,
  prefsKey,
  readIds,
  useListLoading,
  useRowSelection,
  useSuperListQuery,
  writeIds,
  useBaseTabCounts,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { SelectionBar } from '../../sales/selection-bar.tsx';
import { SalesSavedViews } from '../../sales/sales-saved-views.tsx';
import { useSavedFilters } from '../../sales/sales-saved.ts';
import { numberFormat } from '../../shared/intl.ts';
import { shortId } from '../../shared/short-id.ts';
import {
  DEFAULT_COLUMNS,
  DEFAULT_QUERY,
  FILTER_FIELDS,
  LIST_KEY,
  MAX_LIST_ROWS,
  PAGE_SIZES,
  READ_CAP,
  SEARCH_MAX,
  SELECTION_MAX,
  cleanColumns,
  filterCount,
  orderKey,
  payloadOf,
  queryOf,
  queryString,
  requestIdOf,
  somethingToSave,
  type Filters,
  type ListPagingMode,
  type OptionalColumn,
  type Query,
  type SavedPayload,
  type View,
} from './list-types.ts';
import { RequestsBulk } from './requests-bulk.tsx';
import {
  RequestsColumnsPanel,
  RequestsFilterPanel,
  RequestsSortPanel,
} from './requests-panels.tsx';
import { RequestsTable, useRequestRowActions } from './requests-table.tsx';
import { API_REQUESTS_LIST, type ListPage } from './types.ts';

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
// Only a whole request id asks for anything: other text keeps the search the query had, and the
// box shows a hint. An emptied box clears the search.
const withSearch = (current: Query, text: string): Query => {
  if (text.trim() === '') return { ...current, q: '' };
  return requestIdOf(text) === null ? current : { ...current, q: text.trim() };
};

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
 * The admin Issuer requests list (Certificates > Issuer requests; a super list): the open
 * requests, oldest first by default, with its view tab and count, a search by request id, the
 * filter, sort and column panels with their chips, saved filters, row selection with "Select all
 * matching", Export (the Bulk action menu; there is no bulk answer), the Market's List paging
 * (page numbers with a total, or Previous and next) and an Actions menu per row (Open, and Answer
 * with the edit key, as the API says per row). The list reads at most 500 open requests; a notice
 * says so when more are open. The column choice is the admin's own and lives in this browser.
 */
export function RequestsList({
  paging,
  accountId,
  marketId,
  zone,
  typeNames,
  sellerId = null,
  csrfToken = '',
}: {
  /** The Market's "List paging" setting, Previous and next when it could not be read. */
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  /** The IANA zone of the table's times and of the date presets (ADR-0005). */
  readonly zone: string;
  /** Type code to name; empty when the admin may not read the certification types. */
  readonly typeNames: Readonly<Record<string, string>>;
  /** One seller's requests, from a link; shown as a chip that can be removed. */
  readonly sellerId?: string | null;
  /** The CSRF token of the session, for saving, renaming, moving and deleting saved filters. */
  readonly csrfToken?: string;
}) {
  const t = useTranslations('certificates.requests');
  const ts = useTranslations('sales-lists');
  const to = useTranslations('orders');
  const tl = useTranslations('load');
  const locale = useLocale();
  const {
    query,
    draft,
    setDraft,
    savedId,
    change,
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

  const [answer, setAnswer] = useState<ListPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [hinted, setHinted] = useState(false);
  const [columns, setColumns] = useState<readonly OptionalColumn[]>(DEFAULT_COLUMNS);
  const latest = useRef(0);
  const storageKey = prefsKey('admin', marketId, accountId, 'issuer-requests-columns');
  // After a page change the focus moves to the top of the list, so a keyboard or screen reader
  // user starts on the new rows and not on the pager they used.
  const listTop = useRef<HTMLDivElement>(null);
  const focusList = useRef(false);
  // The saved filters: null until they load, and when the route cannot answer (the list then has
  // its built-in tab only, no Save filter and no Manage filters). Every control that needs them
  // checks for null.
  const { saved, reload: loadSaved } = useSavedFilters<SavedPayload>(LIST_KEY);
  const [dialog, setDialog] = useState<'save' | 'manage' | null>(null);
  // A saved filter is a tab of its own: it does not narrow the counts of the built-in tab.
  const tabCounts = useBaseTabCounts<ListPage['counts']>({
    savedId,
    live: answer?.counts ?? null,
    load: async () => {
      const request = queryString(
        { ...DEFAULT_QUERY, sellerId },
        { paging, zone, now: new Date() },
      );
      const result = await callApi<ListPage>('GET', `${API_REQUESTS_LIST}?${request}`);
      return result.ok ? result.body.counts : null;
    },
  });

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
      const result = await callApi<ListPage>('GET', `${API_REQUESTS_LIST}?${request}`);
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

  // A new search, filter or sort is another list: the selection does not follow it. Paging keeps
  // it, so rows can be ticked on several pages.
  const listKey = JSON.stringify([
    query.view,
    query.q,
    query.filters,
    query.sellerId,
    query.sort,
    query.direction,
  ]);
  const rows = answer?.items;
  const pageIds = useMemo(() => rows?.map((row) => row.issuerRequestId) ?? [], [rows]);
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
  // footer fits the rows on show. Without a total the footer is told one row past this page while
  // another follows, so its Next button knows where the end is.
  const mode: ListPagingMode = answer === null || answer.total === null ? 'prev-next' : paging;
  const total =
    answer === null
      ? 0
      : (answer.total ??
        (answer.hasNext
          ? answer.page * answer.pageSize + 1
          : (answer.page - 1) * answer.pageSize + answer.items.length));

  // A page past the end (requests were answered meanwhile) goes to the last one.
  useEffect(() => {
    if (answer === null || loading || failure !== null) return;
    if (answer.items.length === 0 && answer.page > 1) {
      const last =
        answer.total === null ? 1 : Math.max(1, Math.ceil(answer.total / answer.pageSize));
      goToPage(Math.min(last, answer.page - 1));
    }
  }, [answer, loading, failure, goToPage]);

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const typedId = requestIdOf(query.q);
  // The hint about the typed text waits for the box to lose focus or Enter, so it is not read out
  // at the first keystroke of every search.
  const showHint = hinted && draft.trim() !== '' && requestIdOf(draft) === null;

  const saveColumns = (next: readonly OptionalColumn[]) => {
    setColumns(next);
    writeIds(browserStorage(), storageKey, next);
  };
  const clearAll = () => {
    reset({ q: '', filters: {}, sellerId: null });
    forgetSellerInUrl();
  };
  const withoutFilter = (field: (typeof FILTER_FIELDS)[number]): Filters =>
    Object.fromEntries(Object.entries(query.filters).filter(([name]) => name !== field));

  const filterValue = (field: (typeof FILTER_FIELDS)[number]): string | null => {
    const value = query.filters[field];
    if (value === undefined) return null;
    return field === 'type' ? (typeNames[value] ?? value) : ts(`date-preset.${value}`);
  };
  const chips = [
    ...(typedId === null
      ? []
      : [
          {
            key: 'search',
            label: t('chip-search', { id: shortId(typedId) }),
            onRemove: () => reset({ q: '' }),
          },
        ]),
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
  // "Save filter" is offered on the built-in tab when it shows something a saved filter can keep.
  const canSave = saved !== null && savedId === null && somethingToSave(query);
  const sortField = t(`sort.field.${query.sort}`);
  const sortOrder = t(`sort.${orderKey(query.sort, query.direction)}`);
  const summary = [
    t('tab.all'),
    ...chips
      .filter((chip) => (FILTER_FIELDS as readonly string[]).includes(chip.key))
      .map((chip) => chip.label),
    ...(query.sort !== DEFAULT_QUERY.sort || query.direction !== DEFAULT_QUERY.direction
      ? [ts('saved.summary-sort', { field: `${sortField}, ${sortOrder}` })]
      : []),
  ].join(' · ');

  const rowActions = useRequestRowActions();
  const totalRows = failure === null && mode === 'pages' ? (answer?.total ?? null) : null;

  const empty = (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : 'shield-check'}
      title={filtered ? t('empty.no-match') : t('empty.none')}
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
      <NoAccess
        title={t('no-access')}
        body={t('no-access-body')}
        backHref="/"
        backLabel={t('back-home')}
      />
    );
  }

  const skeleton = status.skeleton && failure === null;
  const firstLoadError = answer === null && failure === 'unavailable';
  const shown = answer?.items ?? [];
  const wholePageTicked =
    shown.length > 0 &&
    !selection.allMatching &&
    shown.every((row) => selection.selected.has(row.issuerRequestId));
  const moreThanPage =
    mode === 'pages'
      ? (answer?.total ?? 0) > shown.length
      : answer?.hasNext === true || (answer?.page ?? 1) > 1;
  const start = answer === null ? 0 : (answer.page - 1) * answer.pageSize;
  const context = { paging, zone, now: new Date() };

  const table = (
    <div className="flex flex-col gap-4">
      {answer?.truncated === true && failure === null ? (
        <Banner tone="info">{t('truncated', { count: number(READ_CAP) })}</Banner>
      ) : null}
      <SelectionBar
        active={selection.selected.size > 0 || selection.allMatching}
        allMatching={selection.allMatching}
        // Not offered over the cap: the API refuses a selector export of a cut list (413
        // batch.too-large), so the admin ticks rows instead (up to 200).
        canSelectAll={
          wholePageTicked && moreThanPage && failure === null && answer?.truncated !== true
        }
        labels={{
          selected: t('selection.selected', { count: selection.selected.size }),
          all:
            totalRows === null ? t('selection.all-open') : t('selection.all', { count: totalRows }),
          selectAll:
            totalRows === null
              ? t('selection.select-all-open')
              : t('selection.select-all', { count: totalRows }),
          clear: t('selection.clear'),
        }}
        onSelectAll={selection.selectAllMatching}
        onClear={selection.clear}
      />
      <div ref={listTop} tabIndex={-1} className="outline-none">
        <RequestsTable
          rows={shown}
          columns={columns}
          typeNames={typeNames}
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
        subtitle: tabCounts === null ? '' : t('total', { count: tabCounts.all }),
        note: to('zone-note', { zone }),
        actions: (
          <RequestsBulk
            selection={{
              ids: [...selection.selected],
              allMatching: selection.allMatching,
              total: totalRows,
            }}
            query={query}
            context={context}
            columns={columns}
          />
        ),
      }}
      views={{
        label: t('tabs'),
        activeId: savedId ?? query.view,
        onSelect: (id) => {
          const filter = saved?.items.find((item) => item.id === id);
          if (filter === undefined) openView(id);
          else openSavedTab(id, queryOf(filter.payload, query.pageSize));
        },
        items: [
          {
            id: 'all',
            label: `${t('tab.all')}${tabCounts === null ? '' : ` (${number(tabCounts.all)})`}`,
          },
          ...(saved?.items ?? []).map((item) => ({ id: item.id, label: item.name })),
        ],
        manage:
          saved === null
            ? null
            : { label: ts('saved.manage-link'), onClick: () => setDialog('manage') },
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
          if (value === '' || requestIdOf(value) !== null) change({ q: value });
        },
        extra: showHint ? (
          <p role="status" className="w-full text-sm text-fg-muted">
            {t('search.not-an-id')}
          </p>
        ) : null,
      }}
      filter={{
        label: ts('filter.button'),
        count: filterCount(query.filters),
        panel: (close) => (
          <RequestsFilterPanel
            filters={query.filters}
            typeNames={typeNames}
            onApply={(filters) => change({ filters })}
            close={close}
          />
        ),
      }}
      sort={{
        label: ts('sort.button'),
        panel: () => (
          <RequestsSortPanel
            sort={query.sort}
            direction={query.direction}
            onChange={(sort, direction) => change({ sort, direction })}
          />
        ),
      }}
      columns={{
        label: ts('columns.button'),
        panel: (close) => (
          <RequestsColumnsPanel columns={columns} onSave={saveColumns} close={close} />
        ),
      }}
      sortedLine={t('sorted', { field: sortField, order: sortOrder })}
      chips={
        filtered || canSave
          ? {
              chips,
              ...(filtered ? { clearAll: { label: ts('clear-all'), onClick: clearAll } } : {}),
              ...(canSave
                ? { save: { label: ts('saved.save-link'), onClick: () => setDialog('save') } }
                : {}),
              status:
                answer === null || failure !== null || answer.total === null
                  ? ''
                  : t('match', { count: answer.total }),
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
                message: t('error.list-unavailable'),
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
            idPrefix="issuer-requests"
            onSaved={(filter) => {
              void loadSaved().then((items) => {
                // Only a filter that is in the reloaded list can be the tab on show.
                if (items?.some((item) => item.id === filter.id) === true)
                  openSavedTab(filter.id, queryOf(filter.payload, query.pageSize));
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
              page: answer.page,
              pageSize: answer.pageSize,
              pageSizes: PAGE_SIZES,
              total,
              maxRows: MAX_LIST_ROWS,
              range:
                answer.total === null
                  ? t('range-open', {
                      from: number(start + 1),
                      to: number(start + answer.items.length),
                    })
                  : t('range', {
                      from: number(start + 1),
                      to: number(start + answer.items.length),
                      total: number(answer.total),
                    }),
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
              onPageSize: (pageSize) => paginate({ pageSize }),
            }
          : null
      }
    />
  );
}
