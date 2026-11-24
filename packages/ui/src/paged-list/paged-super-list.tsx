'use client';

import {
  ActionMenu,
  Banner,
  Button,
  EmptyState,
  ExportDialog,
  ListColumnsPanel,
  ListFilterPanel,
  ListSortPanel,
  SuperList,
  SuperTable,
  browserStorage,
  listSkeletonRowCount,
  prefsKey,
  readIds,
  saveFile,
  toast,
  useListLoading,
  useRowSelection,
  useSuperListQuery,
  writeIds,
  type ActionMenuItem,
  type ExportFormat,
  type SuperColumn,
} from '../index.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cleanColumnIds } from './columns.ts';
import {
  PagedSavedDialogs,
  fits,
  payloadOf,
  queryOfPayload,
  usePagedSavedFilters,
  type SavedFilter,
} from './saved.tsx';
import { SelectionBar } from './selection-bar.tsx';
import {
  DEFAULT_PAGED_QUERY,
  MAX_PAGED_ROWS,
  PAGE_SIZE,
  type ListPagingMode,
  type PagedListRuntime,
  type PagedAnswer,
  type PagedDateRanges,
  type PagedFilterField,
  type PagedInstantRange,
  type PagedListConfig,
  type PagedQuery,
} from './types.ts';

/** Rows that can be ticked one by one; "Select all matching" has no such limit. */
const SELECTION_MAX = 200;
const OPEN_ENDED = Number.MAX_SAFE_INTEGER;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type Failure = 'denied' | 'refused' | 'unavailable';

function failureOf(status: number, code: string): Failure {
  if (status === 403) return 'denied';
  // The API refused the query itself: asking again can never work.
  if (code === 'validation.failed') return 'refused';
  return 'unavailable';
}

/** The query string a list route is asked: the tab, search, filters, sort and page. */
export function pagedQueryString<Row>(
  config: Pick<PagedListConfig<Row>, 'tabs' | 'tabParam' | 'tabParams' | 'search'>,
  query: PagedQuery,
  paging: ListPagingMode,
  dates?: PagedDateRanges,
): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(config.tabParams?.(query.tab) ?? {})) {
    // A tab that sets no value for a parameter (a list's "all") leaves it out.
    if (value !== undefined) params.set(name, value);
  }
  if (query.tab !== config.tabs[0] && config.tabParam !== undefined) {
    params.set(config.tabParam, query.tab);
  }
  if (query.q !== '') params.set(config.search?.param ?? 'q', query.q);
  for (const [name, value] of Object.entries(query.filters)) {
    const range = dates?.fields.find((field) => field.id === name)?.range;
    if (range === undefined) {
      params.set(name, value);
      continue;
    }
    // A date preset is read on each load: "Last 7 days" keeps meaning the last seven days.
    const instants = dates?.resolve(value) ?? null;
    if (instants !== null) {
      params.set(range.from, instants.from);
      params.set(range.to, instants.to);
    }
  }
  params.set('page', String(query.page));
  params.set('pageSize', String(PAGE_SIZE));
  params.set('paging', paging);
  // Previous and next has no sort menu: the route's own order applies.
  if (paging === 'pages') {
    params.set('sort', query.sort);
    params.set('direction', query.direction);
  }
  return params.toString();
}

/**
 * One page-numbered super list of the Catalogue (views, search, filter panel with chips, sort,
 * column picker, row selection with "select all matching", Bulk action with Export, page numbers
 * or Previous and next following the Market's List paging setting, phone cards, row Actions
 * menu). The list's own words live in the namespace `config.ns`:
 * `intro`, `tabs`, `tab.<id>`, `search.label`, `search.placeholder`, `sort.field.<id>`,
 * `sort.by`, `sort.order`, `sorted`, `col.<id>`, `filter.title`, `row-name`, `loading`, `match`,
 * `error.{unavailable,refused}`, `empty.{title,body,no-match,no-match-help}`, `select.*`,
 * `selection.*`, `actions.{header,for}`, `bulk.{button,selected,all-open,export}` and
 * `export.*`. The layout, spacing, states and phone behaviour are the kit's.
 *
 * Saved personal and shared filters (tabs after the built-in ones, "Save filter…", "Manage
 * filters…") are on when the list names its `savedKey` and the page passes `csrfToken`; their words
 * are the panel's `sales-lists.saved.*`.
 */
export function PagedSuperList<Row>({
  config,
  paging,
  accountId,
  marketId,
  fields = [],
  loadCounts,
  heading,
  embedded = false,
  dialogs,
  refreshKey = 0,
  onAnswer,
  csrfToken,
  dateRange,
  runtime,
}: {
  readonly config: PagedListConfig<Row>;
  /** The Market's "List paging" setting; Previous and next when it could not be read. */
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  readonly fields?: readonly PagedFilterField[];
  /** Tab counts for the filter on show (the tab ids it returns get a count). */
  readonly loadCounts?: (
    filters: Readonly<Record<string, string>>,
  ) => Promise<Readonly<Record<string, number>> | null>;
  readonly heading?: React.ReactNode;
  /** A list inside a record's tab or card: its buttons stay in the list's own row. */
  readonly embedded?: boolean;
  /** Dialogs the row actions open (a decision, a merge); the page owns them. */
  readonly dialogs?: React.ReactNode;
  /** Changes when the page changed rows (a decision was made): the list is read again. */
  readonly refreshKey?: number;
  /** Each good answer, whole (a list route may carry more than the contract, such as locales). */
  readonly onAnswer?: (answer: PagedAnswer<Row>) => void;
  /** The session's CSRF token: with the list's `savedKey` it turns saved filters on. */
  readonly csrfToken?: string;
  /**
   * Turns the preset a date field holds into instants, on the clock of the list's zone (ADR-0005);
   * needed when `fields` has a field with `range`.
   */
  readonly dateRange?: (preset: string) => PagedInstantRange | null;
  /** The panel's translations, locale and relay call (the kit does not know the panel's i18n). */
  readonly runtime: PagedListRuntime;
}) {
  const { useTranslations, useLocale, callApi } = runtime;
  const t = useTranslations(config.ns);
  const ts = useTranslations('sales-lists');
  const tl = useTranslations('load');
  const locale = useLocale();
  const defaults = useMemo(() => DEFAULT_PAGED_QUERY(config), [config]);
  const {
    query,
    draft,
    setDraft,
    savedId,
    change,
    goToPage,
    openView,
    openSaved,
    forgetSaved,
    reset,
  } = useSuperListQuery<PagedQuery>({
    defaultQuery: defaults,
    forView: (view) => ({ ...defaults, tab: view }),
    withView: (current, view) => ({ ...current, tab: view, page: 1 }),
    searchOf: (current) => current.q,
    withSearch: (current, text) => ({ ...current, q: text }),
    ...(config.search?.accepts === undefined ? {} : { searchAccepts: config.search.accepts }),
  });
  const [hinted, setHinted] = useState(false);
  const typed = draft.trim();
  // The hint waits for Enter or for the box to lose focus, so it is not read out while typing.
  const showHint =
    hinted && typed !== '' && config.search?.accepts !== undefined && !config.search.accepts(typed);

  const [answer, setAnswer] = useState<PagedAnswer<Row> | null>(null);
  const [counts, setCounts] = useState<Readonly<Record<string, number>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [columns, setColumns] = useState<readonly string[]>(config.defaultColumns);
  const [dialog, setDialog] = useState<'export' | 'save' | 'manage' | null>(null);
  const savedOn = config.savedKey !== undefined && csrfToken !== undefined;
  const { saved, reload: loadSaved } = usePagedSavedFilters(runtime, config.savedKey, savedOn);
  const savedHere = useMemo(
    () => saved?.items.filter((item) => fits(config, item)) ?? [],
    [saved, config],
  );
  // A saved tab that was deleted (here or by its owner) is no longer the one on show.
  useEffect(() => {
    if (savedId !== null && saved !== null && !savedHere.some((item) => item.id === savedId)) {
      forgetSaved();
    }
  }, [saved, savedHere, savedId, forgetSaved]);
  const [exporting, setExporting] = useState(false);
  const latest = useRef(0);
  const onAnswerRef = useRef(onAnswer);
  onAnswerRef.current = onAnswer;
  const datesRef = useRef<PagedDateRanges>({ fields, resolve: () => null });
  datesRef.current = { fields, resolve: dateRange ?? (() => null) };
  const storageKey = prefsKey('admin', marketId, accountId, `${config.ns}-columns`);
  const listTop = useRef<HTMLDivElement>(null);
  const focusList = useRef(false);

  useEffect(() => {
    setColumns(
      cleanColumnIds(
        readIds(browserStorage(), storageKey),
        config.optionalColumns,
        config.defaultColumns,
      ),
    );
  }, [storageKey, config]);

  const load = useCallback(
    async (asked: PagedQuery) => {
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const result = await callApi<PagedAnswer<Row>>(
        'GET',
        `${config.endpoint}?${pagedQueryString(config, asked, paging, datesRef.current)}`,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        if (result.failure.status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        setFailure(failureOf(result.failure.status, result.failure.code));
        return;
      }
      setAnswer(result.body);
      onAnswerRef.current?.(result.body);
    },
    [config, paging],
  );

  const queryNow = useRef(query);
  queryNow.current = query;
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    void load(queryNow.current);
  }, [load, queryKey, refreshKey]);

  // The tab counts follow the filters (not the tab, search or page).
  // A saved filter's own filters are not the built-in tabs': their counts stay on the clean list.
  const filtersKey = JSON.stringify(savedId === null ? query.filters : {});
  useEffect(() => {
    if (loadCounts === undefined) return;
    let current = true;
    void loadCounts(JSON.parse(filtersKey) as Record<string, string>).then((next) => {
      if (current && next !== null) setCounts(next);
    });
    return () => {
      current = false;
    };
  }, [loadCounts, filtersKey, refreshKey]);

  // A new tab, search, filter or sort is another list: the selection does not follow it.
  const listKey = JSON.stringify([query.tab, query.q, query.filters, query.sort, query.direction]);
  const rows = answer?.items;
  const pageIds = useMemo(() => rows?.map(config.rowId) ?? [], [rows, config]);
  const selection = useRowSelection(pageIds, SELECTION_MAX, listKey);
  // A change the page made (a decision) leaves nothing ticked.
  const clearSelection = selection.clear;
  useEffect(() => {
    clearSelection();
  }, [refreshKey, clearSelection]);
  const status = useListLoading(loading, answer !== null);
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

  const mode: ListPagingMode = answer === null || answer.total === null ? 'prev-next' : 'pages';
  const page = answer?.page ?? query.page;

  // A page past the end (rows were removed meanwhile) goes back to the last one with rows.
  useEffect(() => {
    if (answer === null || loading || failure !== null || answer.items.length > 0) return;
    if (answer.page > 1) {
      const last =
        answer.total === null ? answer.page - 1 : Math.ceil(answer.total / answer.pageSize);
      goToPage(Math.max(1, Math.min(last, answer.page - 1)));
    }
  }, [answer, loading, failure, goToPage]);

  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const saveColumns = (next: readonly string[]) => {
    setColumns(next);
    writeIds(browserStorage(), storageKey, next);
  };
  const clearAll = () => reset({ q: '', filters: {}, page: 1 });
  const withoutFilter = (field: string) =>
    Object.fromEntries(Object.entries(query.filters).filter(([name]) => name !== field));

  const chips = [
    ...(query.q === ''
      ? []
      : [
          {
            key: 'search',
            label: t('chip-search', { text: query.q }),
            onRemove: () => reset({ q: '' }),
          },
        ]),
    ...fields.flatMap((field) => {
      const value = field.options.find((option) => option.value === query.filters[field.id]);
      return value === undefined
        ? []
        : [
            {
              key: field.id,
              label: ts('chip', { field: field.label, value: value.label }),
              onRemove: () => change({ filters: withoutFilter(field.id) }),
            },
          ];
    }),
  ].map((chip) => ({ ...chip, removeLabel: ts('chip-remove', { filter: chip.label }) }));
  // Clear all and Save filter… appear only while a search or filter is active, as on the Products
  // list; a tab or a sort on its own is a view, not a filter.
  const filtered = chips.length > 0;
  const sortChanged = query.sort !== defaults.sort || query.direction !== defaults.direction;
  const canSave = saved !== null && savedId === null && filtered;

  const total = failure === null && mode === 'pages' ? (answer?.total ?? null) : null;

  async function exportFile(format: ExportFormat) {
    if (config.exportEndpoint === undefined) return;
    setExporting(true);
    const params = new URLSearchParams(pagedQueryString(config, query, paging, datesRef.current));
    const dropped = [
      'page',
      'pageSize',
      'paging',
      ...(config.exportKeepsSort === true ? [] : ['sort', 'direction']),
    ];
    for (const key of dropped) params.delete(key);
    params.set('format', format);
    const work = (async () => {
      let response: Response;
      try {
        response = await fetch(`/api/${config.exportEndpoint}?${params.toString()}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
      } catch {
        throw new Error(t('export.unavailable'));
      }
      if (!response.ok) {
        const body = (await response.json().catch((): unknown => null)) as {
          code?: string;
          details?: { max?: number };
        } | null;
        throw new Error(
          body?.code === 'batch.too-large'
            ? t('export.too-large', { max: body.details?.max ?? 10000 })
            : t('export.unavailable'),
        );
      }
      // The bytes as sent: text() would drop the CSV's byte order mark, which Excel needs.
      const blob = new Blob([await response.arrayBuffer()], {
        type: format === 'xlsx' ? XLSX_TYPE : 'text/csv;charset=utf-8',
      });
      saveFile(
        blob,
        `${config.exportName ?? 'export'}-${new Date().toISOString().slice(0, 10)}.${format}`,
      );
    })();
    try {
      await toast.promise(
        work,
        {
          pending: t('export.pending'),
          success: t('export.done'),
          error: (error: unknown) =>
            error instanceof Error ? error.message : t('export.unavailable'),
        },
        { id: `${config.ns}-export` },
      );
    } catch {
      // The toast says what went wrong.
    } finally {
      setExporting(false);
      setDialog(null);
    }
  }

  if (failure === 'denied') {
    return <p className="text-fg-muted">{t('no-access')}</p>;
  }

  const skeleton = status.skeleton && failure === null;
  const firstLoadError = answer === null && failure === 'unavailable';
  const shown = answer?.items ?? [];
  const wholePageTicked =
    shown.length > 0 &&
    !selection.allMatching &&
    shown.every((row) => selection.selected.has(config.rowId(row)));
  const moreThanPage =
    mode === 'pages' ? (answer?.total ?? 0) > shown.length : answer?.hasNext === true || page > 1;
  const start = (page - 1) * PAGE_SIZE;
  const sort = config.sorts.find((each) => each.id === query.sort) ?? config.sorts[0];
  const sortOrder =
    sort === undefined ? '' : sort.orders[query.direction === sort.defaultDirection ? 0 : 1];
  const selectedCount = selection.allMatching ? (total ?? 0) : selection.selected.size;
  const hasSelection = selection.allMatching || selection.selected.size > 0;

  // Bulk decisions run on the ticked rows of this page: their versions are the ones it showed.
  const tickedHere = selection.allMatching
    ? []
    : shown.filter((row) => selection.selected.has(config.rowId(row)));
  const bulkItems: ActionMenuItem[] = [
    ...(config.bulk ?? []).map((action) => ({
      id: action.id,
      label: action.label,
      disabled: tickedHere.length === 0 || failure !== null,
      onSelect: () => action.run(tickedHere),
    })),
    ...(config.exportEndpoint === undefined
      ? []
      : [{ id: 'export', label: t('bulk.export'), onSelect: () => setDialog('export') }]),
  ];

  const savedSummary = [
    ...(query.tab === config.tabs[0] ? [] : [t(`tab.${query.tab}`)]),
    ...chips.map((chip) => chip.label),
    ...(sortChanged && sort !== undefined
      ? [ts('saved.summary-sort', { field: t(`sort.field.${sort.id}`) })]
      : []),
  ].join(' · ');
  const openSavedFilter = (filter: SavedFilter) =>
    openSaved(filter.id, queryOfPayload(config, defaults, filter.payload));

  const empty = (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : (config.icon ?? 'package')}
      title={filtered ? t('empty.no-match') : t('empty.title')}
      body={filtered ? t('empty.no-match-help') : t.has('empty.body') ? t('empty.body') : undefined}
      action={
        filtered ? (
          <Button
            variant="secondary"
            onClick={() => reset({ q: '', filters: {}, tab: config.tabs[0] ?? 'all' })}
          >
            {ts('clear-all')}
          </Button>
        ) : undefined
      }
    />
  );

  const defs: SuperColumn<Row>[] = [...config.fixedColumns, ...columns].map((id) =>
    config.columnDefs(id, t(`col.${id}`)),
  );

  const table = (
    <div className="flex flex-col gap-4">
      {mode === 'pages' && (answer?.total ?? 0) > MAX_PAGED_ROWS ? (
        <Banner tone="info">{t('too-many', { limit: number(MAX_PAGED_ROWS) })}</Banner>
      ) : null}
      <SelectionBar
        active={hasSelection}
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
        <SuperTable<Row>
          caption={t('title')}
          rows={shown}
          rowId={config.rowId}
          rowName={config.rowName}
          columns={defs}
          {...(config.readOnly === true
            ? {}
            : {
                selection: {
                  state: selection,
                  labels: {
                    page: t('select.page'),
                    pageShort: t('select.page-short'),
                    row: (name: string) => t('select.row', { name }),
                  },
                },
              })}
          {...(config.readOnly === true
            ? {}
            : {
                actions: {
                  header: t('actions.header'),
                  label: (name: string) => t('actions.for', { name }),
                  // Rows kept after a failed refresh belong to another list than the query: no actions.
                  items: failure === null ? config.rowActions : () => [],
                },
              })}
          empty={empty}
          {...(skeleton ? { skeletonRows: listSkeletonRowCount(PAGE_SIZE) } : {})}
          minWidthClass={
            defs.length > 6 ? 'lg:min-w-300' : defs.length > 4 ? 'lg:min-w-240' : 'lg:min-w-160'
          }
        />
      </div>
    </div>
  );

  return (
    <SuperList
      heading={{
        ...(embedded ? { embedded: true } : {}),
        // A list whose page has the Help panel needs no line here: `intro` is optional.
        ...(embedded && t.has('intro') ? { note: t('intro') } : {}),
        actions: (
          <>
            {heading}
            {config.readOnly === true ? null : (
              <ActionMenu
                label={t('bulk.button')}
                title={
                  selection.allMatching && total === null
                    ? t('bulk.all-open')
                    : t('bulk.selected', { count: selectedCount })
                }
                items={bulkItems}
                disabled={bulkItems.length === 0 || !hasSelection}
              />
            )}
          </>
        ),
      }}
      views={{
        label: t('tabs'),
        activeId: savedId ?? query.tab,
        onSelect: (id) => {
          const filter = savedHere.find((item) => item.id === id);
          if (filter === undefined) openView(id);
          else openSavedFilter(filter);
        },
        items: [
          ...config.tabs.map((tab) => ({
            id: tab,
            label: `${t(`tab.${tab}`)}${counts === null || counts[tab] === undefined ? '' : ` (${number(counts[tab])})`}`,
          })),
          // The saved filter on show carries the live total; the registry keeps no count for the rest.
          ...savedHere.map((item) => ({
            id: item.id,
            label: `${item.name}${item.id === savedId && total !== null ? ` (${number(total)})` : ''}`,
          })),
        ],
        manage:
          saved === null
            ? null
            : { label: ts('saved.manage-link'), onClick: () => setDialog('manage') },
      }}
      {...(config.search === undefined
        ? {}
        : {
            search: {
              label: t('search.label'),
              placeholder: t('search.placeholder'),
              value: draft,
              maxLength: config.search.max,
              onChange: (value: string) => {
                setHinted(false);
                setDraft(value);
              },
              onBlur: () => setHinted(true),
              onSubmit: (value: string) => {
                setHinted(true);
                const text = value.trim();
                if (text !== '' && config.search?.accepts?.(text) === false) return;
                change({ q: value });
              },
              ...(showHint
                ? {
                    extra: (
                      <p role="status" className="w-full text-sm text-fg-muted">
                        {t('search.invalid')}
                      </p>
                    ),
                  }
                : {}),
            },
          })}
      {...(fields.length === 0
        ? {}
        : {
            filter: {
              label: ts('filter.button'),
              count: Object.keys(query.filters).length,
              panel: (close: () => void) => (
                <ListFilterPanel
                  fields={fields.map((field) => ({
                    id: field.id,
                    label: field.label,
                    options: [...field.options],
                  }))}
                  values={query.filters}
                  labels={{
                    title: t('filter.title'),
                    matchAll: ts('filter.match-all'),
                    field: ts('filter.field'),
                    fieldPlaceholder: ts('filter.field-placeholder'),
                    is: ts('filter.is'),
                    value: ts('filter.value'),
                    valuePlaceholder: ts('filter.value-placeholder'),
                    remove: ts('filter.remove'),
                    add: ts('filter.add'),
                    cancel: ts('filter.cancel'),
                    apply: ts('filter.apply'),
                  }}
                  onApply={(values) => change({ filters: values })}
                  close={close}
                />
              ),
            },
          })}
      {...(paging === 'pages' && config.sorts.length > 0
        ? {
            sort: {
              label: ts('sort.button'),
              panel: () => (
                <ListSortPanel
                  sort={query.sort}
                  direction={query.direction}
                  fields={config.sorts.map((each) => ({
                    id: each.id,
                    label: t(`sort.field.${each.id}`),
                  }))}
                  defaultDirection={(id) =>
                    config.sorts.find((each) => each.id === id)?.defaultDirection ?? 'asc'
                  }
                  orderLabels={(id) =>
                    config.sorts.find((each) => each.id === id)?.orders ?? ['', '']
                  }
                  labels={{ by: t('sort.by'), order: t('sort.order') }}
                  name={`${config.ns}-sort`}
                  onChange={(id, direction) => change({ sort: id, direction })}
                />
              ),
            },
          }
        : {})}
      {...(config.optionalColumns.length === 0
        ? {}
        : {
            columns: {
              label: ts('columns.button'),
              panel: (close: () => void) => (
                <ListColumnsPanel
                  columns={columns}
                  optional={config.optionalColumns}
                  defaults={config.defaultColumns}
                  fixed={config.fixedColumns.map((id) => ({ id, label: t(`col.${id}`) }))}
                  optionalLabel={(column) => t(`col.${column}`)}
                  labels={{
                    title: ts('columns.title'),
                    help: ts('columns.help'),
                    always: ts('columns.always'),
                    up: (column) => ts('columns.up', { column }),
                    down: (column) => ts('columns.down', { column }),
                    reset: ts('columns.reset'),
                    save: ts('columns.save'),
                  }}
                  onSave={(next) =>
                    saveColumns(cleanColumnIds(next, config.optionalColumns, config.defaultColumns))
                  }
                  close={close}
                />
              ),
            },
          })}
      {...(paging === 'pages' && sort !== undefined
        ? { sortedLine: t('sorted', { field: t(`sort.field.${sort.id}`), order: sortOrder }) }
        : {})}
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
        failure === null
          ? null
          : failure === 'refused'
            ? { message: t('error.refused') }
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
              pageSize: PAGE_SIZE,
              pageSizes: [PAGE_SIZE],
              total:
                mode === 'pages'
                  ? Math.min(answer.total ?? 0, MAX_PAGED_ROWS)
                  : answer.hasNext
                    ? page * PAGE_SIZE + 1
                    : (page - 1) * PAGE_SIZE + answer.items.length,
              maxRows: mode === 'pages' ? MAX_PAGED_ROWS : OPEN_ENDED,
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
              onPageSize: () => {},
            }
          : null
      }
      dialogs={
        <>
          {dialogs}
          {saved === null || config.savedKey === undefined || csrfToken === undefined ? null : (
            <PagedSavedDialogs
              runtime={runtime}
              ts={ts}
              dialog={dialog === 'save' || dialog === 'manage' ? dialog : null}
              onClose={() => setDialog(null)}
              listKey={config.savedKey}
              payload={payloadOf(config, query)}
              summary={savedSummary}
              saved={saved}
              items={savedHere}
              csrfToken={csrfToken}
              idPrefix={config.ns}
              onSaved={(filter) => {
                // The new filter is a tab at once: the list shows it.
                void loadSaved().then((items) => {
                  const kept = items?.find((item) => item.id === filter.id);
                  if (kept !== undefined) openSavedFilter(kept);
                  else toast.error(ts('saved.error.unavailable'));
                });
              }}
              onChanged={() => void loadSaved()}
            />
          )}
          {config.exportEndpoint === undefined ? null : (
            <ExportDialog
              open={dialog === 'export'}
              onClose={() => setDialog(null)}
              busy={exporting}
              labels={{
                title: t('export.title'),
                body: t('export.body'),
                legend: t('export.legend'),
                csv: t('export.csv'),
                csvHelp: t('export.csv-help'),
                xlsx: t('export.xlsx'),
                xlsxHelp: t('export.xlsx-help'),
                confirm: t('export.confirm'),
                cancel: t('export.cancel'),
              }}
              onConfirm={(format) => void exportFile(format)}
            />
          )}
        </>
      }
    />
  );
}
