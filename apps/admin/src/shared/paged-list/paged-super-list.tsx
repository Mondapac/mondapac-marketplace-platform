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
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { cleanColumnIds } from '../../sales/columns.ts';
import { SelectionBar } from '../../sales/selection-bar.tsx';
import { numberFormat } from '../intl.ts';
import {
  DEFAULT_PAGED_QUERY,
  MAX_PAGED_ROWS,
  PAGE_SIZE,
  type ListPagingMode,
  type PagedAnswer,
  type PagedFilterField,
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
  config: Pick<PagedListConfig<Row>, 'tabs' | 'tabParam'>,
  query: PagedQuery,
  paging: ListPagingMode,
): string {
  const params = new URLSearchParams();
  if (query.tab !== config.tabs[0] && config.tabParam !== undefined) {
    params.set(config.tabParam, query.tab);
  }
  if (query.q !== '') params.set('q', query.q);
  for (const [name, value] of Object.entries(query.filters)) params.set(name, value);
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
 * Saved filters join here once the list has its key in the shared registry (backend PR #918).
 */
export function PagedSuperList<Row>({
  config,
  paging,
  accountId,
  marketId,
  fields = [],
  loadCounts,
  heading,
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
}) {
  const t = useTranslations(config.ns);
  const ts = useTranslations('sales-lists');
  const tl = useTranslations('load');
  const locale = useLocale();
  const defaults = useMemo(() => DEFAULT_PAGED_QUERY(config), [config]);
  const { query, draft, setDraft, change, goToPage, openView, reset } =
    useSuperListQuery<PagedQuery>({
      defaultQuery: defaults,
      forView: (view) => ({ ...defaults, tab: view }),
      withView: (current, view) => ({ ...current, tab: view, page: 1 }),
      searchOf: (current) => current.q,
      withSearch: (current, text) => ({ ...current, q: text }),
    });

  const [answer, setAnswer] = useState<PagedAnswer<Row> | null>(null);
  const [counts, setCounts] = useState<Readonly<Record<string, number>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [columns, setColumns] = useState<readonly string[]>(config.defaultColumns);
  const [dialog, setDialog] = useState<'export' | null>(null);
  const [exporting, setExporting] = useState(false);
  const latest = useRef(0);
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
        `${config.endpoint}?${pagedQueryString(config, asked, paging)}`,
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
    },
    [config, paging],
  );

  const queryNow = useRef(query);
  queryNow.current = query;
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    void load(queryNow.current);
  }, [load, queryKey]);

  // The tab counts follow the filters (not the tab, search or page).
  const filtersKey = JSON.stringify(query.filters);
  useEffect(() => {
    if (loadCounts === undefined) return;
    let current = true;
    void loadCounts(JSON.parse(filtersKey) as Record<string, string>).then((next) => {
      if (current && next !== null) setCounts(next);
    });
    return () => {
      current = false;
    };
  }, [loadCounts, filtersKey]);

  // A new tab, search, filter or sort is another list: the selection does not follow it.
  const listKey = JSON.stringify([query.tab, query.q, query.filters, query.sort, query.direction]);
  const rows = answer?.items;
  const pageIds = useMemo(() => rows?.map(config.rowId) ?? [], [rows, config]);
  const selection = useRowSelection(pageIds, SELECTION_MAX, listKey);
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

  const number = (value: number) => numberFormat(locale, {}).format(value);
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
  const filtered = chips.length > 0 || query.tab !== config.tabs[0];

  const total = failure === null && mode === 'pages' ? (answer?.total ?? null) : null;

  async function exportFile(format: ExportFormat) {
    if (config.exportEndpoint === undefined) return;
    setExporting(true);
    const params = new URLSearchParams(pagedQueryString(config, query, paging));
    for (const key of ['page', 'pageSize', 'paging', 'sort', 'direction']) params.delete(key);
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

  const bulkItems: ActionMenuItem[] =
    config.exportEndpoint === undefined
      ? []
      : [{ id: 'export', label: t('bulk.export'), onSelect: () => setDialog('export') }];

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
          selection={{
            state: selection,
            labels: {
              page: t('select.page'),
              pageShort: t('select.page-short'),
              row: (name) => t('select.row', { name }),
            },
          }}
          actions={{
            header: t('actions.header'),
            label: (name) => t('actions.for', { name }),
            // Rows kept after a failed refresh belong to another list than the query: no actions.
            items: failure === null ? config.rowActions : () => [],
          }}
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
        subtitle: t('intro'),
        actions: (
          <>
            {heading}
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
          </>
        ),
      }}
      views={{
        label: t('tabs'),
        activeId: query.tab,
        onSelect: (id) => openView(id),
        items: config.tabs.map((tab) => ({
          id: tab,
          label: `${t(`tab.${tab}`)}${counts === null || counts[tab] === undefined ? '' : ` (${number(counts[tab])})`}`,
        })),
        manage: null,
      }}
      search={{
        label: t('search.label'),
        placeholder: t('search.placeholder'),
        value: draft,
        maxLength: config.search.max,
        onChange: setDraft,
        onSubmit: (value) => change({ q: value }),
      }}
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
      {...(paging === 'pages' && config.sorts.length > 1
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
      }
    />
  );
}
