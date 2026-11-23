'use client';

import {
  Button,
  Card,
  EmptyState,
  ExportDialog,
  ListColumnsPanel,
  ListSortPanel,
  SuperList,
  SuperTable,
  TextField,
  browserStorage,
  listSkeletonRowCount,
  prefsKey,
  readIds,
  saveFile,
  toast,
  useListLoading,
  useSuperListQuery,
  writeIds,
  type ExportFormat,
  type MenuItem,
  type SuperColumn,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import { startOfDay } from '../sales/day-start.ts';
import { numberFormat } from '../shared/intl.ts';
import { useStepUpProof } from '../step-up/step-up.tsx';
import { minutesOf } from './security-shared.tsx';
import { EXPORT_PERMISSION } from './list-types.ts';

// One customer-page section that is a super list (customers management phase 2b: Shopping and
// Reviews). Every one of them is the same shape: a POST of `{filters, direction, page, pageSize,
// paging}` to `customers/admin/customers/:id/<path>`, an answer of `{items, page, pageSize, paging,
// total, hasNext}` (plus the owner's extras), and an export of the same filter behind a fresh
// two-step code. The section owns its Card, so a 403 (the admin lacks the owner's key) removes the
// whole section and any other failure stays inside it, with Retry.

const PAGE_SIZES = [25, 50, 100] as const;
const MAX_ROWS = 10_000;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface SectionPage<R> {
  readonly items: readonly R[];
  readonly page: number;
  readonly pageSize: number;
  readonly paging: 'pages' | 'prev-next';
  readonly total: number | null;
  readonly hasNext: boolean;
}

export interface SectionColumn<R> {
  readonly id: string;
  /** The first column: always shown, the card title on a phone. */
  readonly primary?: boolean;
  readonly numeric?: boolean;
  readonly cell: (row: R) => ReactNode;
}

export type SectionFilter =
  /** The API has no filter for this list. */
  | { readonly kind: 'none' }
  /** One closed set of values in `filters.<field>` (reviews: status), shown as the views bar. */
  | { readonly kind: 'values'; readonly field: string; readonly values: readonly string[] }
  /** `filters.from` and `filters.to`: the admin's local days turned into instants. */
  | { readonly kind: 'range' };

interface Query {
  readonly view: string;
  readonly from: string;
  readonly to: string;
  readonly direction: 'asc' | 'desc';
  readonly page: number;
  readonly pageSize: number;
}

const DEFAULT_QUERY: Query = {
  view: 'all',
  from: '',
  to: '',
  direction: 'desc',
  page: 1,
  pageSize: 25,
};

class ExportFailure extends Error {
  constructor(
    readonly key: string,
    readonly values: Record<string, number> = {},
  ) {
    super(key);
  }
}

function exportFailureOf(failure: ApiFailure): ExportFailure {
  if (failure.code === 'batch.too-large') {
    return new ExportFailure('too-large', {
      max: failure.details?.max ?? 0,
      total: failure.details?.total ?? 0,
    });
  }
  if (failure.status === 429) {
    return new ExportFailure('throttled', {
      minutes: minutesOf(failure, 60),
    });
  }
  if (failure.code === 'second-factor.enrolment-required') return new ExportFailure('enrol');
  if (failure.status === 401 || failure.status === 403) return new ExportFailure('denied');
  return new ExportFailure('unavailable');
}

export interface SectionListProps<R> {
  readonly accountId: string;
  readonly adminAccountId: string;
  readonly marketId: string;
  readonly csrfToken: string;
  readonly zone: string;
  readonly paging: 'pages' | 'prev-next';
  readonly keys: ReadonlySet<string>;
  /** The route under `customers/admin/customers/:id/` ("saved-items"). */
  readonly path: string;
  /** The list's own words: title, subtitle, caption, empty, export-title, col.*, view.*. */
  readonly ns: string;
  readonly columns: readonly SectionColumn<R>[];
  /** Columns the picker may hide, in the order they show by default. */
  readonly optional: readonly string[];
  readonly defaultOptional: readonly string[];
  readonly filter: SectionFilter;
  /** The column the API sorts by (the only sort). */
  readonly sortColumn: string;
  readonly rowId: (row: R, index: number) => string;
  readonly rowName: (row: R) => string;
  readonly rowActions?: (row: R) => readonly MenuItem[];
  /** Words or figures the API sends beside the page (the assistant's conversation count). */
  readonly aside?: (answer: SectionPage<R> & Readonly<Record<string, unknown>>) => string | null;
}

/**
 * A super list in a card (rule 14): views or a date filter with removable chips, sort, the column
 * picker (kept in this browser), page numbers per the Market's List paging setting, the phone
 * layout, and Export (CSV or XLSX of the current filter) behind the export key and a fresh code.
 * Known exceptions, which these lists' APIs do not offer: search, saved filters and row selection.
 */
export function SectionList<R>(props: SectionListProps<R>) {
  const {
    accountId,
    adminAccountId,
    marketId,
    csrfToken,
    zone,
    paging,
    keys,
    path,
    ns,
    columns,
    optional,
    defaultOptional,
    filter,
    sortColumn,
    rowId,
    rowName,
    rowActions,
    aside,
  } = props;
  const t = useTranslations(ns);
  const ts = useTranslations('customers.sections');
  const tl = useTranslations('customers.list');
  const tload = useTranslations('load');
  const locale = useLocale();
  const prove = useStepUpProof();
  const [answer, setAnswer] = useState<(SectionPage<R> & Record<string, unknown>) | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<'denied' | 'invalid' | 'throttled' | 'unavailable' | null>(
    null,
  );
  const [minutes, setMinutes] = useState(1);
  const [shown, setShown] = useState<readonly string[]>(defaultOptional);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const latest = useRef(0);
  const storageKey = `${prefsKey('admin', marketId, adminAccountId, 'customer-section-columns')}:${path}`;
  const numberOf = (value: number) => numberFormat(locale, {}).format(value);

  const list = useSuperListQuery<Query>({
    defaultQuery: DEFAULT_QUERY,
    forView: (view) => ({ ...DEFAULT_QUERY, view }),
    withView: (current, view) => ({ ...current, view, page: 1 }),
    searchOf: () => '',
    withSearch: (current) => current,
  });
  const { query } = list;

  useEffect(() => {
    const stored = readIds(browserStorage(), storageKey);
    if (stored !== null && stored !== undefined) {
      setShown(stored.filter((id) => optional.includes(id)));
    }
  }, [storageKey, optional]);

  const filtersOf = useCallback(
    (next: Query): Record<string, unknown> => {
      if (filter.kind === 'values') {
        return next.view === 'all' ? {} : { [filter.field]: [next.view] };
      }
      if (filter.kind === 'range') {
        const from = next.from === '' ? null : startOfDay(next.from, zone);
        const to = next.to === '' ? null : startOfDay(next.to, zone, 1);
        return { ...(from === null ? {} : { from }), ...(to === null ? {} : { to }) };
      }
      return {};
    },
    [filter, zone],
  );

  const load = useCallback(
    async (next: Query) => {
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const filters = filtersOf(next);
      // A variable, not a literal: the eight routes are checked one by one in bff.spec.ts.
      const url = `customers/admin/customers/${encodeURIComponent(accountId)}/${path}`;
      const result = await callApi<SectionPage<R> & Record<string, unknown>>(
        'POST',
        url,
        {
          ...(Object.keys(filters).length === 0 ? {} : { filters }),
          direction: next.direction,
          page: next.page,
          pageSize: next.pageSize,
          paging,
        },
        csrfToken,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        if (result.failure.status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        if (result.failure.status === 429) {
          setMinutes(minutesOf(result.failure, 60));
        }
        setFailure(
          result.failure.status === 403
            ? 'denied'
            : result.failure.status === 429
              ? 'throttled'
              : result.failure.code === 'validation.failed'
                ? 'invalid'
                : 'unavailable',
        );
        return;
      }
      setAnswer(result.body);
    },
    [accountId, csrfToken, paging, path, filtersOf],
  );

  useEffect(() => {
    void load(query);
  }, [load, query]);

  const status = useListLoading(loading, answer !== null);
  useEffect(() => {
    if (!status.stalled) return;
    latest.current += 1;
    setLoading(false);
    setFailure('unavailable');
  }, [status.stalled]);
  const skeleton = status.skeleton && failure === null;

  async function exportFile(format: ExportFormat) {
    setExporting(true);
    const filters = filtersOf(query);
    const body = {
      format,
      direction: query.direction,
      ...(Object.keys(filters).length === 0 ? {} : { filters }),
    };
    const send = () =>
      fetch(`/api/customers/admin/customers/${encodeURIComponent(accountId)}/${path}/export`, {
        method: 'POST',
        headers: {
          accept: 'text/csv, application/json',
          'content-type': 'application/json',
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
      });
    const failureFrom = async (response: Response): Promise<ApiFailure> => {
      const parsed = (await response
        .json()
        .catch((): unknown => null)) as Partial<ApiFailure> | null;
      return {
        status: response.status,
        code: typeof parsed?.code === 'string' ? parsed.code : 'unknown',
        ...(parsed?.details === undefined ? {} : { details: parsed.details }),
      };
    };
    const work = (async (): Promise<void> => {
      let response: Response;
      try {
        response = await send();
        if (!response.ok) {
          const refused = await failureFrom(response);
          const proof = await prove(refused, csrfToken);
          if (proof === 'cancelled') {
            throw new ExportFailure(
              refused.code === 'second-factor.enrolment-required' ? 'enrol' : 'cancelled',
            );
          }
          if (proof === 'not-asked') throw exportFailureOf(refused);
          response = await send();
          if (!response.ok) throw exportFailureOf(await failureFrom(response));
        }
      } catch (error) {
        if (error instanceof ExportFailure) throw error;
        throw new ExportFailure('unavailable');
      }
      const day = new Date().toISOString().slice(0, 10);
      if (format === 'xlsx') {
        saveFile(
          new Blob([await response.arrayBuffer()], { type: XLSX_TYPE }),
          `customer-${path}-${day}.xlsx`,
        );
        return;
      }
      saveFile(
        new Blob([await response.text()], { type: 'text/csv;charset=utf-8' }),
        `customer-${path}-${day}.csv`,
      );
    })();
    try {
      await toast.promise(
        work,
        {
          pending: ts('export.pending'),
          success: () => ts('export.done'),
          error: (error: unknown) =>
            error instanceof ExportFailure
              ? ts(`export.error.${error.key}`, error.values)
              : ts('export.error.unavailable'),
        },
        { id: `customer-${path}-export` },
      );
    } catch {
      // The toast says what went wrong.
    } finally {
      setExporting(false);
    }
  }

  // A 403 on any page hides the whole section, as it does on the first load.
  if (failure === 'denied') return null;

  const ranged = filter.kind === 'range' && (query.from !== '' || query.to !== '');
  const filtered = ranged || (filter.kind === 'values' && query.view !== 'all');
  const chips = [
    ...(query.from === ''
      ? []
      : [{ key: 'from', label: ts('chip.from', { day: query.from }), patch: { from: '' } }]),
    ...(query.to === ''
      ? []
      : [{ key: 'to', label: ts('chip.to', { day: query.to }), patch: { to: '' } }]),
  ];
  const total =
    answer === null
      ? 0
      : (answer.total ??
        (answer.page - 1) * answer.pageSize + answer.items.length + (answer.hasNext ? 1 : 0));
  const start = answer === null ? 0 : (answer.page - 1) * answer.pageSize;
  const views = filter.kind === 'values' ? ['all', ...filter.values] : ['all'];
  const shownColumns = optional.filter((id) => shown.includes(id));
  const tableColumns: SuperColumn<R>[] = columns
    .filter((column) => !optional.includes(column.id) || shownColumns.includes(column.id))
    .sort((a, b) => {
      const order = (id: string) => (optional.includes(id) ? shownColumns.indexOf(id) : -1);
      return order(a.id) - order(b.id);
    })
    .map((column) => ({
      id: column.id,
      header: t(`col.${column.id}`),
      ...(column.primary === true ? { primary: true } : {}),
      ...(column.numeric === true ? { numeric: true } : {}),
      cell: column.cell,
    }));
  const fixed = columns
    .filter((column) => !optional.includes(column.id))
    .map((column) => ({ id: column.id, label: t(`col.${column.id}`) }));
  const aside_ = answer === null || failure !== null ? null : (aside?.(answer) ?? null);

  return (
    <Card title={t('title')}>
      <SuperList
        heading={{
          subtitle:
            aside_ === null ? t('subtitle', { zone }) : `${t('subtitle', { zone })} ${aside_}`,
          actions: keys.has(EXPORT_PERMISSION) ? (
            <Button
              variant="secondary"
              disabled={exporting || total === 0}
              onClick={() => setExportOpen(true)}
            >
              {ts('export.button')}
            </Button>
          ) : undefined,
        }}
        views={{
          label: ts('views', { section: t('title') }),
          activeId: query.view,
          onSelect: (id) => list.openView(id),
          items: views.map((view) => ({
            id: view,
            label: view === 'all' ? ts('view-all') : t(`view.${view}`),
          })),
          manage: null,
        }}
        {...(filter.kind === 'range'
          ? {
              filter: {
                label: ts('filter.button'),
                count: chips.length,
                panel: (close: () => void) => (
                  <DayRangePanel
                    from={query.from}
                    to={query.to}
                    onApply={(from, to) => list.change({ from, to })}
                    close={close}
                  />
                ),
              },
            }
          : {})}
        sort={{
          label: tl('sort.button'),
          panel: () => (
            <ListSortPanel
              name={`customer-${path}-sort`}
              sort={sortColumn}
              direction={query.direction}
              fields={[{ id: sortColumn, label: t(`col.${sortColumn}`) }]}
              defaultDirection={() => 'desc'}
              orderLabels={() => [tl('sort.date.first'), tl('sort.date.second')]}
              labels={{ by: tl('sort.by'), order: tl('sort.order') }}
              onChange={(_sort, direction) => list.change({ direction })}
            />
          ),
        }}
        columns={{
          label: tl('columns.button'),
          panel: (close) => (
            <ListColumnsPanel
              columns={shown}
              optional={optional}
              defaults={defaultOptional}
              fixed={fixed}
              optionalLabel={(column) => t(`col.${column}`)}
              labels={{
                title: tl('columns.title'),
                help: tl('columns.help'),
                always: tl('columns.always'),
                up: (column) => tl('columns.up', { column }),
                down: (column) => tl('columns.down', { column }),
                reset: tl('columns.reset'),
                save: tl('columns.save'),
              }}
              onSave={(next) => {
                const clean = next.filter((id) => optional.includes(id));
                setShown(clean);
                writeIds(browserStorage(), storageKey, clean);
              }}
              close={close}
            />
          ),
        }}
        sortedLine={ts('sorted', {
          field: t(`col.${sortColumn}`),
          order: query.direction === 'desc' ? tl('sort.date.first') : tl('sort.date.second'),
        })}
        chips={
          ranged
            ? {
                chips: chips.map((chip) => ({
                  key: chip.key,
                  label: chip.label,
                  removeLabel: tl('chip-remove', { filter: chip.label }),
                  onRemove: () => list.change(chip.patch),
                })),
                clearAll: {
                  label: tl('clear-all'),
                  onClick: () => list.change({ from: '', to: '' }),
                },
                status:
                  answer === null || failure !== null || answer.total === null
                    ? ''
                    : ts('match', { count: answer.total }),
              }
            : null
        }
        failure={
          failure === null
            ? null
            : {
                message:
                  failure === 'throttled'
                    ? ts('error.throttled', { minutes })
                    : failure === 'invalid'
                      ? ts('error.invalid')
                      : ts('error.unavailable', { section: t('title') }),
                ...(failure === 'unavailable' || failure === 'throttled'
                  ? { retry: { label: ts('retry'), onClick: () => void load(query) } }
                  : {}),
              }
        }
        firstLoadError={answer === null && (failure === 'unavailable' || failure === 'throttled')}
        loading={loading}
        status={status}
        loadingLabel={ts('loading', { section: t('title') })}
        slowLabel={tload('slow')}
        ready={answer !== null}
        table={
          <SuperTable
            caption={t('caption')}
            rows={answer?.items ?? []}
            rowId={(row) => rowId(row, (answer?.items ?? []).indexOf(row))}
            rowName={rowName}
            columns={tableColumns}
            {...(rowActions === undefined
              ? {}
              : {
                  actions: {
                    header: tl('col.actions'),
                    label: (name: string) => ts('row-menu', { name }),
                    items: rowActions,
                  },
                })}
            empty={
              <EmptyState
                size="compact"
                icon={filtered ? 'search' : 'clock'}
                title={filtered ? ts('empty-filtered') : t('empty')}
                action={
                  ranged ? (
                    <Button variant="secondary" onClick={() => list.change({ from: '', to: '' })}>
                      {tl('clear-filters')}
                    </Button>
                  ) : undefined
                }
              />
            }
            skeletonRows={skeleton ? listSkeletonRowCount(query.pageSize) : undefined}
            minWidthClass="lg:min-w-160"
          />
        }
        pagination={
          answer === null || total === 0
            ? null
            : {
                mode: paging,
                page: answer.page,
                pageSize: answer.pageSize,
                pageSizes: PAGE_SIZES,
                total,
                maxRows: MAX_ROWS,
                range:
                  answer.total === null
                    ? ts('range-open', {
                        from: numberOf(start + 1),
                        to: numberOf(start + answer.items.length),
                      })
                    : ts('range', {
                        from: numberOf(start + 1),
                        to: numberOf(start + answer.items.length),
                        total: numberOf(answer.total),
                      }),
                labels: {
                  rowsPerPage: tl('paging.rows-per-page'),
                  previous: tl('paging.previous'),
                  next: tl('paging.next'),
                  pages: tl('paging.pages'),
                  page: (page) => tl('paging.page', { page }),
                  narrowTitle: tl('paging.narrow-title'),
                  narrowBody: tl('paging.narrow-body'),
                },
                disabled: loading,
                onPage: list.goToPage,
                onPageSize: (size) => list.change({ pageSize: size }),
              }
        }
        dialogs={
          <ExportDialog
            open={exportOpen}
            onClose={() => setExportOpen(false)}
            busy={exporting}
            labels={{
              title: t('export-title'),
              body: ts('export.body'),
              legend: tl('bulk.dialog.legend'),
              csv: tl('bulk.dialog.csv'),
              csvHelp: tl('bulk.dialog.csv-help'),
              xlsx: tl('bulk.dialog.xlsx'),
              xlsxHelp: tl('bulk.dialog.xlsx-help'),
              confirm: tl('bulk.dialog.confirm'),
              cancel: tl('bulk.dialog.cancel'),
            }}
            onConfirm={(format) => {
              setExportOpen(false);
              void exportFile(format);
            }}
          />
        }
      />
    </Card>
  );
}

/** The day range of a date filter (days in the admin's zone, both ends included). */
function DayRangePanel({
  from,
  to,
  onApply,
  close,
}: {
  readonly from: string;
  readonly to: string;
  readonly onApply: (from: string, to: string) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('customers.sections.filter');
  const [draft, setDraft] = useState({ from, to });
  const [errors, setErrors] = useState<{ from?: string; to?: string }>({});

  function apply(event: FormEvent) {
    event.preventDefault();
    const next = { from: draft.from.trim(), to: draft.to.trim() };
    const problems: { from?: string; to?: string } = {};
    if (next.from !== '' && !DAY.test(next.from)) problems.from = t('error.day');
    if (next.to !== '' && !DAY.test(next.to)) problems.to = t('error.day');
    if (problems.to === undefined && next.from !== '' && next.to !== '' && next.to < next.from) {
      problems.to = t('error.range');
    }
    if (problems.from !== undefined || problems.to !== undefined) {
      setErrors(problems);
      return;
    }
    onApply(next.from, next.to);
    close();
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={apply} noValidate>
      <h2 className="text-base font-semibold">{t('title')}</h2>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-fg">{t('when')}</legend>
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label={t('from')}
            type="date"
            value={draft.from}
            error={errors.from}
            onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
          />
          <TextField
            label={t('to')}
            type="date"
            value={draft.to}
            error={errors.to}
            onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
          />
        </div>
      </fieldset>
      <div className="flex justify-end gap-2 border-t border-line-row pt-3">
        <Button variant="secondary" onClick={close}>
          {t('cancel')}
        </Button>
        <Button type="submit">{t('apply')}</Button>
      </div>
    </form>
  );
}
