'use client';

import {
  ActionMenu,
  Badge,
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
  type MenuItem,
  type SuperColumn,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { numberFormat } from '../shared/intl.ts';
import { cleanColumnIds } from '../sales/columns.ts';
import { TimeCell } from '../sales/cells.tsx';
import { SalesSavedViews } from '../sales/sales-saved-views.tsx';
import { useSavedFilters } from '../sales/sales-saved.ts';
import { SelectionBar } from '../sales/selection-bar.tsx';
import { toCsv, toXlsx, type Cell } from './export-file.ts';
import { LIST_KEY, payloadOf, queryOf, somethingToSave, type SavedPayload } from './list-saved.ts';
import { rowId, viewCounts, visibleRows } from './rows.ts';
import {
  DEFAULT_QUERY,
  FILTER_FIELDS,
  MIN_COUNTS,
  PAGE_SIZE,
  REASONS,
  SEARCH_MAX,
  SELECTION_MAX,
  SORTS,
  VIEWS,
  defaultDirection,
  filterCount,
  filtersOf,
  type Filters,
  type Query,
  type Sort,
  type UnansweredRow,
  type View,
} from './types.ts';

const NS = 'assistant-insights.list';
const FIXED_COLUMNS = ['query'] as const;
const OPTIONAL_COLUMNS = [
  'count',
  'reasons',
  'last',
  'unavailable',
  'tool-failed',
  'no-results',
  'thumbs-down',
] as const;
type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];
const DEFAULT_COLUMNS: readonly OptionalColumn[] = ['count', 'reasons', 'last'];
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const NAME_CHARS = 40;

const forView = (view: string): Query => ({ ...DEFAULT_QUERY, view: view as View });
const withView = (current: Query, view: string): Query => ({
  ...current,
  view: view as View,
  page: 1,
});
const searchOf = (current: Query): string => current.q;
const withSearch = (current: Query, text: string): Query => ({
  ...current,
  q: text.slice(0, SEARCH_MAX),
});

const shorten = (text: string): string => {
  const chars = Array.from(text);
  return chars.length > NAME_CHARS ? `${chars.slice(0, NAME_CHARS).join('')}…` : text;
};

/**
 * The unanswered questions of the buyer assistant as a super list (views by reason with counts,
 * search, filter panel with chips, sort, column picker, saved filters, row selection with "select
 * all matching", Bulk action with Export, page numbers or Previous and next, phone cards, row
 * Actions menu). The route sends at most 200 groups of masked buyer text, already grouped, so the
 * list holds them all and does the view, search, filters, sort and paging here. The text is shown
 * as plain text only and the export keeps spreadsheets from running it as a formula.
 */
export function UnansweredList({
  rows,
  loading,
  truncated,
  paging,
  zone,
  accountId,
  marketId,
  csrfToken,
  fromDay,
  toDay,
}: {
  readonly rows: readonly UnansweredRow[];
  readonly loading: boolean;
  /** The route read only the newest flagged turns. */
  readonly truncated: boolean;
  readonly paging: 'pages' | 'prev-next';
  readonly zone: string;
  readonly accountId: string;
  readonly marketId: string;
  readonly csrfToken: string;
  readonly fromDay: string;
  readonly toDay: string;
}) {
  const t = useTranslations(NS);
  const ts = useTranslations('sales-lists');
  const tl = useTranslations('load');
  const locale = useLocale();
  const {
    query,
    draft,
    setDraft,
    savedId,
    change,
    goToPage,
    openView,
    openSaved: openSavedTab,
    forgetSaved,
    reset,
  } = useSuperListQuery<Query>({
    defaultQuery: DEFAULT_QUERY,
    forView,
    withView,
    searchOf,
    withSearch,
  });
  const [columns, setColumns] = useState<readonly OptionalColumn[]>(DEFAULT_COLUMNS);
  const [dialog, setDialog] = useState<'save' | 'manage' | 'export' | null>(null);
  const [exporting, setExporting] = useState(false);
  const storageKey = prefsKey('admin', marketId, accountId, 'assistant-insights-columns');
  const { saved, reload: loadSaved } = useSavedFilters<SavedPayload>(LIST_KEY);
  const status = useListLoading(loading, rows.length > 0);

  useEffect(() => {
    setColumns(
      cleanColumnIds(readIds(browserStorage(), storageKey), OPTIONAL_COLUMNS, DEFAULT_COLUMNS),
    );
  }, [storageKey]);

  useEffect(() => {
    if (savedId !== null && saved !== null && !saved.items.some((item) => item.id === savedId)) {
      forgetSaved();
    }
  }, [saved, savedId, forgetSaved]);

  const counts = useMemo(() => viewCounts(rows), [rows]);
  const matching = useMemo(() => visibleRows(rows, query), [rows, query]);
  const total = matching.length;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(query.page, lastPage);
  const start = (page - 1) * PAGE_SIZE;
  const shown = matching.slice(start, start + PAGE_SIZE);

  // A page past the end (the filter narrowed) goes back to the last one.
  useEffect(() => {
    if (query.page > lastPage) goToPage(lastPage);
  }, [query.page, lastPage, goToPage]);

  const listKey = JSON.stringify([query.view, query.q, query.filters, query.sort, query.direction]);
  const pageIds = useMemo(() => shown.map(rowId), [shown]);
  const selection = useRowSelection(pageIds, SELECTION_MAX, listKey);

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const saveColumns = (next: readonly OptionalColumn[]) => {
    setColumns(next);
    writeIds(browserStorage(), storageKey, next);
  };
  const clearAll = () => reset({ q: '', filters: {} });
  const withoutFilter = (field: (typeof FILTER_FIELDS)[number]): Filters =>
    Object.fromEntries(Object.entries(query.filters).filter(([name]) => name !== field));

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast.success(t('actions.copied'));
      } catch {
        toast.error(t('actions.copy-failed'));
      }
    },
    [t],
  );
  const rowActions = (row: UnansweredRow): readonly MenuItem[] => [
    { id: 'copy', label: t('actions.copy'), onSelect: () => void copy(row.query) },
  ];

  const filterValue = (field: (typeof FILTER_FIELDS)[number]): string | null => {
    const value = query.filters[field];
    if (value === undefined) return null;
    return field === 'reason'
      ? t(`reason.${value}`)
      : t('filter.at-least', { count: Number(value) });
  };
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
  const canSave = saved !== null && savedId === null && somethingToSave(query);
  const sortField = t(`sort.field.${query.sort}`);
  const sortOrder = t(
    `sort.${query.sort}.${query.direction === defaultDirection(query.sort) ? 'first' : 'second'}`,
  );
  const summary = [
    t(`view.${query.view}`),
    ...chips.filter((chip) => chip.key !== 'search').map((chip) => chip.label),
    ...(query.sort !== DEFAULT_QUERY.sort || query.direction !== DEFAULT_QUERY.direction
      ? [ts('saved.summary-sort', { field: `${sortField}, ${sortOrder}` })]
      : []),
  ].join(' · ');

  const reasonBadges = (row: UnansweredRow) => (
    <span className="flex flex-wrap gap-1">
      {REASONS.filter((reason) => (row.reasons[reason] ?? 0) > 0).map((reason) => (
        <Badge key={reason} tone={reason === 'thumbs-down' ? 'attention' : 'neutral'}>
          {t('reason-count', { reason: t(`reason.${reason}`), count: row.reasons[reason] ?? 0 })}
        </Badge>
      ))}
    </span>
  );
  const columnDef = (id: string, header: string): SuperColumn<UnansweredRow> => {
    switch (id as OptionalColumn | 'query') {
      case 'query':
        return {
          id,
          header,
          primary: true,
          headClassName: 'lg:min-w-72',
          // Buyer text: a plain text node, never markup; the language of the text is not ours.
          cell: (row) => (
            <span dir="auto" className="break-words font-medium">
              {row.query}
            </span>
          ),
        };
      case 'count':
        return { id, header, numeric: true, cell: (row) => number(row.count) };
      case 'reasons':
        return { id, header, cell: reasonBadges };
      case 'last':
        return { id, header, cell: (row) => <TimeCell at={row.lastAt} zone={zone} /> };
      default:
        return {
          id,
          header,
          numeric: true,
          cell: (row) => number(row.reasons[id as (typeof REASONS)[number]] ?? 0),
        };
    }
  };
  const defs = [...FIXED_COLUMNS, ...columns].map((id) => columnDef(id, t(`col.${id}`)));

  function exportFile(format: ExportFormat) {
    setExporting(true);
    try {
      const chosen = selection.allMatching
        ? matching
        : matching.filter((row) => selection.selected.has(rowId(row)));
      const header = [
        t('col.query'),
        t('col.count'),
        ...REASONS.map((reason) => t(`col.${reason}`)),
        t('col.last'),
      ];
      const lines: Cell[][] = chosen.map((row) => [
        row.query,
        row.count,
        ...REASONS.map((reason) => row.reasons[reason] ?? 0),
        row.lastAt,
      ]);
      const bytes =
        format === 'xlsx' ? toXlsx(t('export.sheet'), header, lines) : toCsv(header, lines);
      saveFile(
        new Blob([bytes as BlobPart], {
          type: format === 'xlsx' ? XLSX_TYPE : 'text/csv;charset=utf-8',
        }),
        `assistant-unanswered-${fromDay}-to-${toDay}.${format}`,
      );
      toast.success(t('export.done'), { id: 'assistant-insights-export' });
    } catch {
      toast.error(t('export.unavailable'), { id: 'assistant-insights-export' });
    } finally {
      setExporting(false);
      setDialog(null);
    }
  }

  const hasSelection = selection.allMatching || selection.selected.size > 0;
  const selectedCount = selection.allMatching ? total : selection.selected.size;
  const bulkItems: ActionMenuItem[] = [
    { id: 'export', label: t('bulk.export'), onSelect: () => setDialog('export') },
  ];
  const wholePageTicked =
    shown.length > 0 &&
    !selection.allMatching &&
    shown.every((row) => selection.selected.has(rowId(row)));
  const mode = paging;

  const empty = (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : 'shield-check'}
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
  const skeleton = status.skeleton;

  const table = (
    <div className="flex flex-col gap-4">
      <SelectionBar
        active={hasSelection}
        allMatching={selection.allMatching}
        canSelectAll={wholePageTicked && total > shown.length}
        labels={{
          selected: t('selection.selected', { count: selection.selected.size }),
          all: t('selection.all', { count: total }),
          selectAll: t('selection.select-all', { count: total }),
          clear: t('selection.clear'),
        }}
        onSelectAll={selection.selectAllMatching}
        onClear={selection.clear}
      />
      <SuperTable<UnansweredRow>
        caption={t('title')}
        rows={shown}
        rowId={rowId}
        rowName={(row) => t('row-name', { text: shorten(row.query) })}
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
          items: rowActions,
        }}
        empty={empty}
        {...(skeleton ? { skeletonRows: listSkeletonRowCount(PAGE_SIZE) } : {})}
        minWidthClass="lg:min-w-240"
      />
    </div>
  );

  return (
    <SuperList
      heading={{
        subtitle: t('intro'),
        note: truncated ? t('truncated') : undefined,
        actions: (
          <ActionMenu
            label={t('bulk.button')}
            title={t('bulk.selected', { count: selectedCount })}
            items={bulkItems}
            disabled={!hasSelection}
          />
        ),
      }}
      views={{
        label: t('views'),
        activeId: savedId ?? query.view,
        onSelect: (id) => {
          const filter = saved?.items.find((item) => item.id === id);
          if (filter === undefined) openView(id);
          else openSavedTab(id, queryOf(filter.payload));
        },
        items: [
          ...VIEWS.map((view) => ({
            id: view,
            label: `${t(`view.${view}`)} (${number(counts[view])})`,
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
        placeholder: t('search.placeholder'),
        value: draft,
        maxLength: SEARCH_MAX,
        onChange: setDraft,
        onSubmit: (value) => change({ q: value.slice(0, SEARCH_MAX) }),
      }}
      filter={{
        label: ts('filter.button'),
        count: filterCount(query.filters),
        panel: (close) => (
          <ListFilterPanel
            fields={[
              {
                id: 'reason',
                label: t('filter.name.reason'),
                options: REASONS.map((value) => ({ value, label: t(`reason.${value}`) })),
              },
              {
                id: 'minCount',
                label: t('filter.name.minCount'),
                options: MIN_COUNTS.map((value) => ({
                  value,
                  label: t('filter.at-least', { count: Number(value) }),
                })),
              },
            ]}
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
            onApply={(values) => change({ filters: filtersOf(values) })}
            close={close}
          />
        ),
      }}
      sort={{
        label: ts('sort.button'),
        panel: () => (
          <ListSortPanel
            sort={query.sort}
            direction={query.direction}
            fields={SORTS.map((value) => ({ id: value, label: t(`sort.field.${value}`) }))}
            defaultDirection={(value) => defaultDirection(value as Sort)}
            orderLabels={(value) => [
              t(`sort.${value as Sort}.first`),
              t(`sort.${value as Sort}.second`),
            ]}
            labels={{ by: t('sort.by'), order: t('sort.order') }}
            name="assistant-insights-sort"
            onChange={(value, next) => change({ sort: value as Sort, direction: next })}
          />
        ),
      }}
      columns={{
        label: ts('columns.button'),
        panel: (close) => (
          <ListColumnsPanel
            columns={columns}
            optional={OPTIONAL_COLUMNS}
            defaults={DEFAULT_COLUMNS}
            fixed={FIXED_COLUMNS.map((id) => ({ id, label: t(`col.${id}`) }))}
            optionalLabel={(column) => t(`col.${column as OptionalColumn}`)}
            labels={{
              title: ts('columns.title'),
              help: ts('columns.help'),
              always: ts('columns.always'),
              up: (column) => ts('columns.up', { column }),
              down: (column) => ts('columns.down', { column }),
              reset: ts('columns.reset'),
              save: ts('columns.save'),
            }}
            onSave={(next) => saveColumns(cleanColumnIds(next, OPTIONAL_COLUMNS, DEFAULT_COLUMNS))}
            close={close}
          />
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
              status: t('match', { count: total }),
            }
          : null
      }
      failure={null}
      firstLoadError={false}
      loading={loading}
      status={status}
      loadingLabel={t('loading')}
      slowLabel={tl('slow')}
      ready={!loading || rows.length > 0}
      dialogs={
        <>
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
            onConfirm={exportFile}
          />
          {saved === null ? null : (
            <SalesSavedViews
              dialog={dialog === 'save' || dialog === 'manage' ? dialog : null}
              onClose={() => setDialog(null)}
              listKey={LIST_KEY}
              payload={payloadOf(query)}
              summary={summary}
              saved={saved}
              csrfToken={csrfToken}
              idPrefix="assistant-insights"
              onSaved={(filter) => {
                void loadSaved().then((items) => {
                  if (items?.some((item) => item.id === filter.id) === true)
                    openSavedTab(filter.id, queryOf(filter.payload));
                });
              }}
              onChanged={() => void loadSaved()}
            />
          )}
        </>
      }
      table={table}
      pagination={
        shown.length > 0
          ? {
              mode,
              page,
              pageSize: PAGE_SIZE,
              pageSizes: [PAGE_SIZE],
              total,
              maxRows: Number.MAX_SAFE_INTEGER,
              range:
                mode === 'pages'
                  ? t('range', {
                      from: number(start + 1),
                      to: number(start + shown.length),
                      total: number(total),
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
              onPage: (target) => goToPage(target),
              onPageSize: () => {},
            }
          : null
      }
    />
  );
}
