'use client';

import {
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
  prefsKey,
  readIds,
  saveFile,
  shortAge,
  useListLoading,
  useSuperListQuery,
  workQueueRows,
  workQueueStatus,
  workQueueTone,
  writeIds,
  type BadgeTone,
  type ExportFormat,
  type MenuItem,
  type SuperColumn,
  type WorkQueueAnswer,
  type WorkQueueRow,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toCsv, toXlsx, type Cell } from '../assistant-insights/export-file.ts';
import { shortInstantInZone } from '../shared/format.ts';
import { useLevelText, useQueueDefinitions, useStatusText } from './labels.ts';
import {
  DEFAULT_COLUMNS,
  DEFAULT_QUERY,
  FILTER_FIELDS,
  OPTIONAL_COLUMNS,
  SEARCH_MAX,
  SORTS,
  STATES,
  VIEWS,
  applyQuery,
  cleanColumns,
  defaultDirection,
  viewCounts,
  type Filters,
  type OptionalColumn,
  type Query,
  type QueueState,
  type Sort,
  type View,
} from './work-queue-query.ts';

const TONE: Record<ReturnType<typeof workQueueTone>, BadgeTone> = {
  critical: 'critical',
  attention: 'attention',
  neutral: 'neutral',
};

const forView = (view: string): Query => ({ ...DEFAULT_QUERY, view: view as View });
const withView = (current: Query, view: string): Query => ({ ...current, view: view as View });
const searchText = (current: Query): string => current.q;
const withSearch = (current: Query, q: string): Query => ({ ...current, q });

/**
 * The full work queue (design sections 2 and 6): every queue the admin may see, one row each,
 * as a super list: views by level with their counts, search by queue name, a filter on the
 * queue's state with chips, sort (oldest first by default), the column picker, Export (CSV and
 * XLSX of the rows on show) and the phone layout. The page reads the queue once; its rows fit on
 * one page, so there is no footer, and nothing acts on a queue, so there is no row selection:
 * the one row action opens the queue's list. Saved filters are in the future-enhancements
 * register. The column choice is the admin's own and lives in this browser's storage.
 */
export function WorkQueueList({
  answer,
  initialView,
  accountId,
  marketId,
  zone,
}: {
  readonly answer: WorkQueueAnswer;
  readonly initialView: View;
  readonly accountId: string;
  readonly marketId: string;
  /** The IANA zone of the queue's times (ADR-0005). */
  readonly zone: string;
}) {
  const t = useTranslations('work-queue.page');
  const ts = useTranslations('sales-lists');
  const tl = useTranslations('load');
  const locale = useLocale();
  const router = useRouter();
  const define = useQueueDefinitions();
  const statusText = useStatusText();
  const levelText = useLevelText();
  const list = useSuperListQuery<Query>({
    defaultQuery: { ...DEFAULT_QUERY, view: initialView },
    forView,
    withView,
    searchOf: searchText,
    withSearch,
  });
  const { query } = list;
  const [columns, setColumns] = useState<readonly OptionalColumn[]>(DEFAULT_COLUMNS);
  const [exporting, setExporting] = useState(false);
  const storageKey = prefsKey('admin', marketId, accountId, 'work-queue-columns');
  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);
  const status = useListLoading(false, true);

  const generated = Date.parse(answer.generatedAt);
  const now = Number.isNaN(generated) ? Date.now() : generated;
  const rows = workQueueRows(answer, define);
  const shown = applyQuery(rows, query, now, locale);
  const counts = viewCounts(rows);

  const ageOf = (row: WorkQueueRow): string | null => {
    const value = workQueueStatus(row, now);
    return 'minutes' in value && value.minutes !== null ? shortAge(value.minutes, locale) : null;
  };
  const statusOf = (row: WorkQueueRow): string => statusText(workQueueStatus(row, now), ageOf(row));
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const oldestOf = (row: WorkQueueRow): string | null =>
    row.state.kind === 'ok' ? row.state.oldestAt : null;

  const columnName = (id: OptionalColumn) => t(`col.${id}`);
  const optionalColumn = (id: OptionalColumn): SuperColumn<WorkQueueRow> => {
    switch (id) {
      case 'level':
        return {
          id,
          header: columnName(id),
          corner: true,
          // Neutral: colour on a row is kept for its status (Reza, UI/UX).
          cell: (row) => <Badge tone="neutral">{levelText(row.level)}</Badge>,
        };
      case 'count':
        return {
          id,
          header: columnName(id),
          numeric: true,
          cell: (row) => (row.state.kind === 'ok' ? number(row.state.count) : '-'),
        };
      case 'overdue':
        return {
          id,
          header: columnName(id),
          numeric: true,
          cell: (row) => (row.state.kind === 'ok' ? number(row.state.overdue) : '-'),
        };
      case 'oldest':
        return {
          id,
          header: columnName(id),
          cell: (row) => {
            const at = oldestOf(row);
            if (at === null) return '-';
            const when = shortInstantInZone(at, locale, zone, true);
            // A dispute's time is its nearest response deadline, not when it came in.
            return (
              <time dateTime={at}>
                {row.signal === 'deadline' ? t('due', { time: when }) : when}
              </time>
            );
          },
        };
      case 'status':
        return {
          id,
          header: columnName(id),
          cell: (row) => {
            const text = statusOf(row);
            const kind = workQueueStatus(row, now).kind;
            return text === '' ? (
              <span className="text-fg-muted">
                {kind === 'clear' ? t('state.clear') : t('no-status')}
              </span>
            ) : (
              <Badge tone={TONE[workQueueTone(workQueueStatus(row, now))]}>{text}</Badge>
            );
          },
        };
    }
  };
  const tableColumns: SuperColumn<WorkQueueRow>[] = [
    {
      id: 'queue',
      header: t('col.queue'),
      primary: true,
      headClassName: 'min-w-64',
      cell: (row) =>
        row.href === null ? (
          <div className="flex min-w-0 flex-col">
            <span className="font-medium wrap-anywhere">{row.label}</span>
            <span className="text-sm text-fg-muted">{t('no-list')}</span>
          </div>
        ) : (
          <a
            href={row.href}
            className="font-medium text-link wrap-anywhere underline focus-visible:outline-2 focus-visible:outline-focus"
          >
            {row.label}
          </a>
        ),
    },
    ...columns.map(optionalColumn),
  ];

  const rowItems = (row: WorkQueueRow): MenuItem[] =>
    row.href === null
      ? []
      : [{ id: 'open', label: t('row.open'), onSelect: () => router.push(row.href as string) }];

  const stateLabel = (value: QueueState) => t(`state.${value}`);
  const chips = [
    ...(query.q.trim() === ''
      ? []
      : [
          {
            key: 'search',
            label: t('chip-search', { text: query.q.trim() }),
            onRemove: () => list.reset({ q: '' }),
          },
        ]),
    ...(query.filters.state === undefined
      ? []
      : [
          {
            key: 'state',
            label: ts('chip', { field: t('filter.state'), value: stateLabel(query.filters.state) }),
            onRemove: () => list.change({ filters: {} }),
          },
        ]),
  ].map((chip) => ({ ...chip, removeLabel: ts('chip-remove', { filter: chip.label }) }));
  const filtered = chips.length > 0;
  const clearAll = () => list.reset({ q: '', filters: {} });

  const sortField = t(`sort.field.${query.sort}`);
  const sortOrder = t(
    `sort.${query.sort}.${query.direction === defaultDirection(query.sort) ? 'first' : 'second'}`,
  );

  function exportRows(format: ExportFormat) {
    setExporting(true);
    try {
      const header = [
        t('col.queue'),
        t('col.level'),
        t('col.count'),
        t('col.overdue'),
        t('col.oldest'),
        t('col.due'),
        t('col.status'),
      ];
      const lines: Cell[][] = shown.map((row) => {
        const deadline = row.signal === 'deadline';
        const status = workQueueStatus(row, now).kind;
        return [
          row.label,
          levelText(row.level),
          row.state.kind === 'ok' ? row.state.count : '',
          row.state.kind === 'ok' ? row.state.overdue : '',
          deadline ? '' : (oldestOf(row) ?? ''),
          deadline ? (oldestOf(row) ?? '') : '',
          statusOf(row) ||
            (status === 'clear' ? t('state.clear') : status === 'waiting' ? t('no-status') : ''),
        ];
      });
      const day = new Date(now).toISOString().slice(0, 10);
      const bytes = format === 'xlsx' ? toXlsx(t('title'), header, lines) : toCsv(header, lines);
      saveFile(
        new Blob([bytes as BlobPart], {
          type:
            format === 'xlsx'
              ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
              : 'text/csv;charset=utf-8',
        }),
        `work-queue-${day}.${format}`,
      );
    } finally {
      setExporting(false);
    }
  }
  const [dialog, setDialog] = useState(false);

  const empty = (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : 'check'}
      title={filtered ? t('empty.no-match') : t(`empty.view.${query.view}`)}
      action={
        filtered ? (
          <Button variant="secondary" onClick={clearAll}>
            {ts('clear-all')}
          </Button>
        ) : undefined
      }
    />
  );

  return (
    <SuperList
      heading={{
        subtitle: t('note', { time: shortInstantInZone(answer.generatedAt, locale, zone, true) }),
        actions: (
          <Button variant="secondary" disabled={shown.length === 0} onClick={() => setDialog(true)}>
            {t('export.button')}
          </Button>
        ),
      }}
      views={{
        label: t('views'),
        activeId: query.view,
        onSelect: (id) => list.openView(id),
        items: VIEWS.map((view) => ({
          id: view,
          label: `${t(`view.${view}`)} (${number(counts[view])})`,
        })),
        manage: null,
      }}
      search={{
        label: t('search.label'),
        placeholder: t('search.placeholder'),
        value: list.draft,
        maxLength: SEARCH_MAX,
        onChange: list.setDraft,
        onSubmit: (value) => list.change({ q: value.trim() }),
      }}
      filter={{
        label: ts('filter.button'),
        count: query.filters.state === undefined ? 0 : 1,
        panel: (close) => (
          <ListFilterPanel
            fields={FILTER_FIELDS.map((field) => ({
              id: field,
              label: t(`filter.${field}`),
              options: STATES.map((value) => ({ value, label: stateLabel(value) })),
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
            onApply={(values) => {
              const state = (STATES as readonly string[]).includes(values['state'] ?? '')
                ? (values['state'] as QueueState)
                : undefined;
              const filters: Filters = state === undefined ? {} : { state };
              list.change({ filters });
            }}
            close={close}
          />
        ),
      }}
      sort={{
        label: ts('sort.button'),
        panel: () => (
          <ListSortPanel
            name="work-queue-sort"
            sort={query.sort}
            direction={query.direction}
            fields={SORTS.map((value) => ({ id: value, label: t(`sort.field.${value}`) }))}
            defaultDirection={(value) => defaultDirection(value as Sort)}
            orderLabels={(value) => [t(`sort.${value}.first`), t(`sort.${value}.second`)]}
            labels={{ by: t('sort.by'), order: t('sort.order') }}
            onChange={(sort, direction) => list.change({ sort: sort as Sort, direction })}
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
            fixed={[{ id: 'queue', label: t('col.queue') }]}
            optionalLabel={(id) => columnName(id as OptionalColumn)}
            labels={{
              title: ts('columns.title'),
              help: ts('columns.help'),
              always: ts('columns.always'),
              up: (column) => ts('columns.up', { column }),
              down: (column) => ts('columns.down', { column }),
              reset: ts('columns.reset'),
              save: ts('columns.save'),
            }}
            onSave={(next) => {
              const clean = cleanColumns(next);
              setColumns(clean);
              writeIds(browserStorage(), storageKey, clean);
            }}
            close={close}
          />
        ),
      }}
      sortedLine={t('sorted', { field: sortField, order: sortOrder })}
      chips={
        filtered
          ? {
              chips,
              clearAll: { label: ts('clear-all'), onClick: clearAll },
              status: t('match', { count: shown.length }),
            }
          : null
      }
      failure={null}
      loading={false}
      status={status}
      loadingLabel={t('loading')}
      slowLabel={tl('slow')}
      ready
      dialogs={
        <ExportDialog
          open={dialog}
          onClose={() => setDialog(false)}
          busy={exporting}
          labels={{
            title: t('export.title'),
            body: t('export.body', { count: shown.length }),
            legend: t('export.legend'),
            csv: t('export.csv'),
            csvHelp: t('export.csv-help'),
            xlsx: t('export.xlsx'),
            xlsxHelp: t('export.xlsx-help'),
            confirm: t('export.confirm'),
            cancel: t('export.cancel'),
          }}
          onConfirm={(format) => {
            setDialog(false);
            exportRows(format);
          }}
        />
      }
      table={
        <SuperTable
          caption={t('title')}
          rows={shown}
          rowId={(row) => row.key}
          rowName={(row) => row.label}
          columns={tableColumns}
          actions={{
            header: t('col.actions'),
            label: (name) => t('row.menu', { name }),
            items: rowItems,
          }}
          empty={empty}
          minWidthClass="lg:min-w-200"
        />
      }
      pagination={null}
    />
  );
}
