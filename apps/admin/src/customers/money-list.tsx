'use client';

import {
  Button,
  Card,
  CheckboxRow,
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
import { orderHref } from '../orders/order-href.ts';
import { startOfDay } from '../sales/day-start.ts';
import { numberFormat } from '../shared/intl.ts';
import { useStepUpProof } from '../step-up/step-up.tsx';
import { EXPORT_PERMISSION } from './list-types.ts';
import { minutesOf } from './security-shared.tsx';
import { MONEY_MAX_ROWS, type ListAnswer } from './money-types.ts';

const PAGE_SIZES = [25, 50, 100] as const;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The stored-choice kind of a list (`PrefsKind` of the UI package, which does not export it). */
type PrefsKind = Parameters<typeof prefsKey>[3];

type Translator = ReturnType<typeof useTranslations>;

/** What a column needs to word and place a cell. */
export interface CellContext {
  /** Scoped to `customers.page.money.<kind>`. */
  readonly t: Translator;
  readonly locale: string;
  readonly zone: string;
  readonly accountId: string;
}

/**
 * One of the Money tab's super lists, described: where it reads, which sort fields, views and
 * closed-choice filter it has, and its columns. The words live under
 * `customers.page.money.<kind>`; the shared ones under `customers.page.money.list`.
 */
export interface MoneyListSpec<Row, Answer extends ListAnswer<Row>> {
  readonly kind: 'payments' | 'disputes' | 'refunds';
  readonly prefs: PrefsKind;
  /** The list's path; the export is this path plus `/export`. */
  readonly path: (accountId: string) => string;
  /** The key that lets the admin see the section (the customers key is held by the page). */
  readonly viewKey: string;
  readonly sorts: readonly string[];
  readonly defaultSort: string;
  /** Which sort fields are dates (newest first) rather than figures (largest first). */
  readonly dateSorts: readonly string[];
  /** The built-in views: the API filter key they fill and its values (empty: All). */
  readonly views: readonly { readonly id: string; readonly values: readonly string[] }[];
  readonly viewFilterKey: string;
  /** A second, closed multi-choice filter in the panel (an order status, a refund reason). */
  readonly choice: { readonly key: string; readonly values: readonly string[] } | null;
  readonly fixed: readonly string[];
  readonly optional: readonly string[];
  readonly defaultOptional: readonly string[];
  readonly rowId: (row: Row) => string;
  readonly rowName: (row: Row) => string;
  readonly orderOf: (row: Row) => string;
  readonly columns: (ctx: CellContext) => {
    readonly first: readonly SuperColumn<Row>[];
    readonly optional: (id: string) => SuperColumn<Row>;
    readonly last: readonly SuperColumn<Row>[];
  };
  /** A line under the heading (for example what the customer paid). */
  readonly note?: (answer: Answer, ctx: CellContext) => string | undefined;
}

interface Query {
  readonly view: string;
  readonly choice: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly sort: string;
  readonly direction: 'asc' | 'desc';
  readonly page: number;
  readonly pageSize: number;
}

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
    return new ExportFailure('throttled', { minutes: minutesOf(failure, 60) });
  }
  if (failure.code === 'second-factor.enrolment-required') return new ExportFailure('enrol');
  if (failure.status === 401 || failure.status === 403) return new ExportFailure('denied');
  return new ExportFailure('unavailable');
}

/**
 * One list of the Money tab as a super list (rule 14): view tabs, a filter panel (a closed
 * choice and a day range, with removable chips), sort, column picker with its own stored choice,
 * Export (CSV or XLSX of the current filter, behind the export key and a fresh two-step code),
 * the row menu (Open order) and the footer of the Market's List paging setting. The APIs have no
 * search, saved filters or row selection for these lists: the PR records them as exceptions. A
 * 403 hides the whole section; another failure is shown inside it, with Retry.
 */
export function MoneyList<Row, Answer extends ListAnswer<Row>>({
  spec,
  accountId,
  adminAccountId,
  marketId,
  keys,
  csrfToken,
  zone,
  paging,
}: {
  readonly spec: MoneyListSpec<Row, Answer>;
  readonly accountId: string;
  readonly adminAccountId: string;
  readonly marketId: string;
  readonly keys: ReadonlySet<string>;
  readonly csrfToken: string;
  readonly zone: string;
  readonly paging: 'pages' | 'prev-next';
}) {
  const t = useTranslations(`customers.page.money.${spec.kind}`);
  const tm = useTranslations('customers.page.money.list');
  const tl = useTranslations('customers.list');
  const tload = useTranslations('load');
  const locale = useLocale();
  const prove = useStepUpProof();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<'denied' | 'invalid' | 'throttled' | 'unavailable' | null>(
    null,
  );
  const [minutes, setMinutes] = useState(1);
  const [columns, setColumns] = useState<readonly string[]>(spec.defaultOptional);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const latest = useRef(0);
  const storageKey = prefsKey('admin', marketId, adminAccountId, spec.prefs);
  const ctx: CellContext = { t, locale, zone, accountId };
  const numberOf = (value: number) => numberFormat(locale, {}).format(value);

  const defaultQuery: Query = {
    view: 'all',
    choice: [],
    from: '',
    to: '',
    sort: spec.defaultSort,
    direction: 'desc',
    page: 1,
    pageSize: 25,
  };
  const list = useSuperListQuery<Query>({
    defaultQuery,
    forView: (view) => ({ ...defaultQuery, view }),
    withView: (current, view) => ({ ...current, view, page: 1 }),
    searchOf: () => '',
    withSearch: (current) => current,
  });
  const { query } = list;

  useEffect(() => {
    const stored = readIds(browserStorage(), storageKey);
    if (stored !== undefined) setColumns(stored.filter((id) => spec.optional.includes(id)));
  }, [storageKey, spec.optional]);

  /** The API's `filters`: the view's values, the choice, and the days as instants in the admin's zone. */
  const filtersOf = useCallback(
    (next: Query): Record<string, readonly string[] | string> => {
      const view = spec.views.find((candidate) => candidate.id === next.view);
      const from = next.from === '' ? null : startOfDay(next.from, zone);
      const to = next.to === '' ? null : startOfDay(next.to, zone, 1);
      return {
        ...(view === undefined || view.values.length === 0
          ? {}
          : { [spec.viewFilterKey]: view.values }),
        ...(spec.choice === null || next.choice.length === 0
          ? {}
          : { [spec.choice.key]: next.choice }),
        ...(from === null ? {} : { from }),
        ...(to === null ? {} : { to }),
      };
    },
    [spec, zone],
  );

  const load = useCallback(
    async (next: Query) => {
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const filters = filtersOf(next);
      const result = await callApi<Answer>(
        'POST',
        spec.path(accountId),
        {
          ...(Object.keys(filters).length === 0 ? {} : { filters }),
          sort: next.sort,
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
        if (result.failure.status === 429) setMinutes(minutesOf(result.failure, 60));
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
    [accountId, csrfToken, filtersOf, paging, spec],
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
      sort: query.sort,
      direction: query.direction,
      ...(Object.keys(filters).length === 0 ? {} : { filters }),
    };
    const send = () =>
      fetch(`/api/${spec.path(accountId)}/export`, {
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
          `customer-${spec.kind}-${day}.xlsx`,
        );
        return;
      }
      saveFile(
        new Blob([await response.text()], { type: 'text/csv;charset=utf-8' }),
        `customer-${spec.kind}-${day}.csv`,
      );
    })();
    try {
      await toast.promise(
        work,
        {
          pending: tm('export.pending'),
          success: () => t('export.done'),
          error: (error: unknown) =>
            error instanceof ExportFailure
              ? tm(`export.error.${error.key}`, error.values)
              : tm('export.error.unavailable'),
        },
        { id: `customer-${spec.kind}-export` },
      );
    } catch {
      // The toast says what went wrong.
    } finally {
      setExporting(false);
    }
  }

  if (failure === 'denied') return null;

  const total =
    answer === null
      ? 0
      : (answer.total ??
        (answer.page - 1) * answer.pageSize + answer.items.length + (answer.hasNext ? 1 : 0));
  const start = answer === null ? 0 : (answer.page - 1) * answer.pageSize;
  const filtered = query.choice.length > 0 || query.from !== '' || query.to !== '';
  const narrowed = filtered || query.view !== 'all';
  const choiceLabel = (value: string) =>
    t.has(`choice.value.${value}`) ? t(`choice.value.${value}`) : value;
  const chips = [
    ...query.choice.map((value) => ({
      key: `choice-${value}`,
      label: tm('chip.choice', { field: t('choice.name'), value: choiceLabel(value) }),
      patch: { choice: query.choice.filter((other) => other !== value) },
    })),
    ...(query.from === ''
      ? []
      : [{ key: 'from', label: tm('chip.from', { day: query.from }), patch: { from: '' } }]),
    ...(query.to === ''
      ? []
      : [{ key: 'to', label: tm('chip.to', { day: query.to }), patch: { to: '' } }]),
  ];

  const parts = spec.columns(ctx);
  const tableColumns: SuperColumn<Row>[] = [
    ...parts.first,
    ...columns.filter((id) => spec.optional.includes(id)).map((id) => parts.optional(id)),
    ...parts.last,
  ];
  const rowItems = (row: Row): MenuItem[] => [
    {
      id: 'open',
      label: tm('row.open'),
      onSelect: () =>
        window.location.assign(orderHref(spec.orderOf(row), { accountId, tab: 'money' })),
    },
  ];
  const sortOrder = (sort: string): readonly [string, string] =>
    spec.dateSorts.includes(sort)
      ? [tl('sort.date.first'), tl('sort.date.second')]
      : [tl('sort.figure.first'), tl('sort.figure.second')];
  const note = answer === null ? undefined : spec.note?.(answer, ctx);

  return (
    <Card title={t('title')}>
      <SuperList
        heading={{
          subtitle: note === undefined ? t('subtitle') : `${t('subtitle')} ${note}`,
          actions: keys.has(EXPORT_PERMISSION) ? (
            <Button
              variant="secondary"
              disabled={exporting || total === 0}
              onClick={() => setExportOpen(true)}
            >
              {tm('export.button')}
            </Button>
          ) : undefined,
        }}
        views={{
          label: t('views'),
          activeId: query.view,
          onSelect: (id) => list.openView(id),
          items: spec.views.map((view) => ({ id: view.id, label: t(`view.${view.id}`) })),
          manage: null,
        }}
        filter={{
          label: tm('filter.button'),
          count: chips.length,
          panel: (close) => (
            <MoneyFilterPanel
              choice={spec.choice}
              choiceName={t('choice.name')}
              choiceLabel={choiceLabel}
              selected={query.choice}
              from={query.from}
              to={query.to}
              onApply={(choice, from, to) => list.change({ choice, from, to })}
              close={close}
            />
          ),
        }}
        sort={{
          label: tl('sort.button'),
          panel: () => (
            <ListSortPanel
              name={`customer-${spec.kind}-sort`}
              sort={query.sort}
              direction={query.direction}
              fields={spec.sorts.map((sort) => ({ id: sort, label: t(`sort.${sort}`) }))}
              defaultDirection={() => 'desc'}
              orderLabels={sortOrder}
              labels={{ by: tl('sort.by'), order: tl('sort.order') }}
              onChange={(sort, direction) => list.change({ sort, direction })}
            />
          ),
        }}
        columns={{
          label: tl('columns.button'),
          panel: (close) => (
            <ListColumnsPanel
              columns={columns}
              optional={spec.optional}
              defaults={spec.defaultOptional}
              fixed={spec.fixed.map((id) => ({ id, label: t(`col.${id}`) }))}
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
                const clean = next.filter((id) => spec.optional.includes(id));
                setColumns(clean);
                writeIds(browserStorage(), storageKey, clean);
              }}
              close={close}
            />
          ),
        }}
        sortedLine={tm('sorted', {
          field: t(`sort.${query.sort}`),
          order: sortOrder(query.sort)[query.direction === 'desc' ? 0 : 1],
        })}
        chips={
          filtered
            ? {
                chips: chips.map((chip) => ({
                  key: chip.key,
                  label: chip.label,
                  removeLabel: tl('chip-remove', { filter: chip.label }),
                  onRemove: () => list.change(chip.patch),
                })),
                clearAll: {
                  label: tl('clear-all'),
                  onClick: () => list.change({ choice: [], from: '', to: '' }),
                },
                status:
                  answer === null || failure !== null || answer.total === null
                    ? ''
                    : tm('match', { count: answer.total }),
              }
            : null
        }
        failure={
          failure === null
            ? null
            : {
                message:
                  failure === 'throttled'
                    ? tm('error.throttled', { minutes })
                    : tm(`error.${failure}`),
                ...(failure === 'unavailable' || failure === 'throttled'
                  ? { retry: { label: tm('retry'), onClick: () => void load(query) } }
                  : {}),
              }
        }
        firstLoadError={answer === null && (failure === 'unavailable' || failure === 'throttled')}
        loading={loading}
        status={status}
        loadingLabel={tm('loading', { section: t('title') })}
        slowLabel={tload('slow')}
        ready={answer !== null}
        table={
          <SuperTable
            caption={t('title')}
            rows={answer?.items ?? []}
            rowId={spec.rowId}
            rowName={spec.rowName}
            columns={tableColumns}
            actions={{
              header: tl('col.actions'),
              label: (name) => tm('row.menu', { name }),
              items: rowItems,
            }}
            empty={
              <EmptyState
                size="compact"
                icon={narrowed ? 'search' : 'receipt'}
                title={narrowed ? t('empty-filtered') : t('empty')}
                action={
                  narrowed ? (
                    <Button
                      variant="secondary"
                      onClick={() => list.reset({ view: 'all', choice: [], from: '', to: '' })}
                    >
                      {tl('clear-filters')}
                    </Button>
                  ) : undefined
                }
              />
            }
            skeletonRows={skeleton ? listSkeletonRowCount(query.pageSize) : undefined}
            minWidthClass="lg:min-w-180"
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
                maxRows: MONEY_MAX_ROWS,
                range:
                  answer.total === null
                    ? tm('range-open', {
                        from: numberOf(start + 1),
                        to: numberOf(start + answer.items.length),
                      })
                    : tl('range', {
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
              title: t('export.title'),
              body: tm('export.body'),
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

/** The filter panel: a closed multi-choice (when the list has one) and a day range in the admin's zone. */
function MoneyFilterPanel({
  choice,
  choiceName,
  choiceLabel,
  selected,
  from,
  to,
  onApply,
  close,
}: {
  readonly choice: { readonly key: string; readonly values: readonly string[] } | null;
  readonly choiceName: string;
  readonly choiceLabel: (value: string) => string;
  readonly selected: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly onApply: (choice: readonly string[], from: string, to: string) => void;
  readonly close: () => void;
}): ReactNode {
  const t = useTranslations('customers.page.money.list.filter');
  const [draft, setDraft] = useState({ from, to });
  const [picked, setPicked] = useState<readonly string[]>(selected);
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
    onApply(picked, next.from, next.to);
    close();
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={apply} noValidate>
      <h2 className="text-base font-semibold">{t('title')}</h2>
      {choice === null ? null : (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium text-fg">{choiceName}</legend>
          {choice.values.map((value) => (
            <CheckboxRow
              key={value}
              label={choiceLabel(value)}
              checked={picked.includes(value)}
              onChange={(event) =>
                setPicked((current) =>
                  event.target.checked
                    ? [...current, value]
                    : current.filter((other) => other !== value),
                )
              }
            />
          ))}
        </fieldset>
      )}
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
