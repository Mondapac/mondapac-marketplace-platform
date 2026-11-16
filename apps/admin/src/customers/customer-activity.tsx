'use client';

import {
  Banner,
  Button,
  Card,
  EmptyState,
  ExportDialog,
  Icon,
  ListColumnsPanel,
  ListSortPanel,
  SidePanel,
  SkeletonRows,
  SuperList,
  SuperTable,
  TextField,
  browserStorage,
  prefsKey,
  readIds,
  saveFile,
  toast,
  listSkeletonRowCount,
  useListLoading,
  useSuperListQuery,
  writeIds,
  type ExportFormat,
  type IconName,
  type MenuItem,
  type SuperColumn,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import { numberFormat } from '../shared/intl.ts';
import { useStepUpProof } from '../step-up/step-up.tsx';
import { timeOf } from './format.ts';
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_MAX_ROWS,
  activityHref,
  isKnownKind,
  type ActivityCategory,
  type ActivityEntry,
  type ActivityPage,
} from './groups-types.ts';
import { EXPORT_PERMISSION } from './list-types.ts';

const RECENT = 5;
const PAGE_SIZES = [25, 50, 100] as const;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type View = 'all' | ActivityCategory;
const VIEWS: readonly View[] = ['all', ...ACTIVITY_CATEGORIES];

const OPTIONAL = ['actor', 'detail'] as const;
type Optional = (typeof OPTIONAL)[number];
const DEFAULT_OPTIONAL: readonly Optional[] = ['actor'];

interface Query {
  readonly view: View;
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

/** The timeline's `filters`: the category tab and the day range (days in the admin's zone). */
function filtersOf(query: Query): Record<string, string> {
  return {
    ...(query.view === 'all' ? {} : { category: query.view }),
    ...(query.from === '' ? {} : { from: query.from }),
    ...(query.to === '' ? {} : { to: query.to }),
  };
}

/** An icon per category, with the kind's words beside it: never colour alone (Reza, 16 Nov). */
const ICON: Readonly<Record<string, IconName>> = {
  account: 'user',
  orders: 'receipt',
  admin: 'shield-check',
};

function useEntryText() {
  const t = useTranslations('customers.activity');
  return (entry: ActivityEntry): string => {
    const kind = isKnownKind(entry.kind) ? entry.kind : 'other';
    if (kind === 'page-opened') {
      const tab = entry.detail ?? '';
      return t('kind.page-opened', {
        tab: ['overview', 'orders', 'money', 'activity'].includes(tab)
          ? t(`tab.${tab}`)
          : t('tab.other'),
      });
    }
    return t(`kind.${kind}`);
  };
}

function actorOf(entry: ActivityEntry, t: ReturnType<typeof useTranslations>): string {
  if (entry.actor === null) return t('actor.none');
  return entry.actor.name ?? t('actor.former-admin');
}

/** Reads one page of the customer's timeline; every read is an audited open of the activity. */
function readActivity(accountId: string, body: Record<string, unknown>, csrfToken: string) {
  return callApi<ActivityPage>(
    'POST',
    `customers/admin/customers/${encodeURIComponent(accountId)}/activity`,
    body,
    csrfToken,
  );
}

/**
 * Recent activity on the Overview (customers management phase 2a): the last five entries of the
 * customer's timeline, each with its icon, one line and the time in the admin's zone, and "All
 * activity", which opens the timeline as a super list in a side panel (full screen on phones).
 */
export function RecentActivity({
  accountId,
  adminAccountId,
  marketId,
  keys,
  csrfToken,
  zone,
  paging,
  refresh,
}: {
  readonly accountId: string;
  readonly adminAccountId: string;
  readonly marketId: string;
  readonly keys: ReadonlySet<string>;
  readonly csrfToken: string;
  readonly zone: string;
  readonly paging: 'pages' | 'prev-next';
  /** Changes when the page did something that lands on the timeline (a note, a group). */
  readonly refresh: number;
}) {
  const t = useTranslations('customers.activity');
  const locale = useLocale();
  const text = useEntryText();
  const [load, setLoad] = useState<
    | { readonly state: 'loading' }
    | { readonly state: 'failed' }
    | { readonly state: 'hidden' }
    | { readonly state: 'ready'; readonly items: readonly ActivityEntry[] }
  >({ state: 'loading' });
  const [open, setOpen] = useState(false);

  const read = useCallback(async () => {
    setLoad({ state: 'loading' });
    const result = await readActivity(
      accountId,
      { page: 1, pageSize: RECENT, paging: 'prev-next' },
      csrfToken,
    );
    if (result.ok) {
      setLoad({ state: 'ready', items: result.body.items });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    // Spec section 8: a section the admin may not read is hidden, not shown as an error.
    setLoad({ state: result.failure.status === 403 ? 'hidden' : 'failed' });
  }, [accountId, csrfToken]);

  useEffect(() => {
    void read();
  }, [read, refresh]);

  if (load.state === 'hidden') return null;
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('recent-title')}</h2>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          {t('all')}
        </Button>
      </div>
      {load.state === 'loading' ? (
        <SkeletonRows label={t('loading')} rows={3} />
      ) : load.state === 'failed' ? (
        <Banner tone="critical">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{t('failed')}</span>
            <Button variant="secondary" onClick={() => void read()}>
              {t('retry')}
            </Button>
          </div>
        </Banner>
      ) : load.items.length === 0 ? (
        <p className="text-fg-muted">{t('empty')}</p>
      ) : (
        <ol className="flex flex-col divide-y divide-line-row" aria-label={t('recent-title')}>
          {load.items.map((entry) => (
            <li key={entry.entryId} className="flex items-start gap-3 py-2.5 first:pt-0">
              <span className="mt-0.5 text-fg-secondary" aria-hidden="true">
                <Icon name={ICON[entry.category] ?? 'info'} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="wrap-anywhere">{text(entry)}</span>
                <span className="text-sm text-fg-muted">
                  {entry.actor === null
                    ? timeOf(entry.occurredAt, locale, zone)
                    : t('by-at', {
                        actor: actorOf(entry, t),
                        time: timeOf(entry.occurredAt, locale, zone),
                      })}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
      <SidePanel
        open={open}
        onClose={() => setOpen(false)}
        title={t('panel-title')}
        closeLabel={t('close')}
      >
        {open ? (
          <ActivityList
            accountId={accountId}
            adminAccountId={adminAccountId}
            marketId={marketId}
            keys={keys}
            csrfToken={csrfToken}
            zone={zone}
            paging={paging}
            numberOf={(value) => numberFormat(locale, {}).format(value)}
          />
        ) : null}
      </SidePanel>
    </Card>
  );
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
  if (failure.code === 'second-factor.enrolment-required') return new ExportFailure('enrol');
  if (failure.status === 401 || failure.status === 403) return new ExportFailure('denied');
  return new ExportFailure('unavailable');
}

/**
 * A customer's activity as a super list (spec section 6): the category tabs (All, Account,
 * Orders, Admin actions), the day range filter with its chips, the sort by time, the column
 * picker, Export (CSV or XLSX of the current filter, behind the export key and a fresh two-step
 * code), the row Actions (Open the order or group) and the footer of the Market's List paging
 * setting. The API has no search, no saved filters and no row selection for the timeline: the
 * PR records these as known exceptions to rule 14.
 */
function ActivityList({
  accountId,
  adminAccountId,
  marketId,
  keys,
  csrfToken,
  zone,
  paging,
  numberOf,
}: {
  readonly accountId: string;
  readonly adminAccountId: string;
  readonly marketId: string;
  readonly keys: ReadonlySet<string>;
  readonly csrfToken: string;
  readonly zone: string;
  readonly paging: 'pages' | 'prev-next';
  readonly numberOf: (value: number) => string;
}) {
  const t = useTranslations('customers.activity');
  const tl = useTranslations('customers.list');
  const tload = useTranslations('load');
  const locale = useLocale();
  const text = useEntryText();
  const prove = useStepUpProof();
  const [answer, setAnswer] = useState<ActivityPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<'denied' | 'invalid' | 'unavailable' | null>(null);
  const [columns, setColumns] = useState<readonly Optional[]>(DEFAULT_OPTIONAL);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const latest = useRef(0);
  const storageKey = prefsKey('admin', marketId, adminAccountId, 'customer-activity-columns');

  const list = useSuperListQuery<Query>({
    defaultQuery: DEFAULT_QUERY,
    forView: (view) => ({ ...DEFAULT_QUERY, view: view as View }),
    withView: (current, view) => ({ ...current, view: view as View, page: 1 }),
    searchOf: () => '',
    withSearch: (current) => current,
  });
  const { query } = list;

  useEffect(() => {
    const stored = readIds(browserStorage(), storageKey);
    if (stored !== null && stored !== undefined) {
      setColumns(
        stored.filter((id): id is Optional => (OPTIONAL as readonly string[]).includes(id)),
      );
    }
  }, [storageKey]);

  const load = useCallback(
    async (next: Query) => {
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const filters = filtersOf(next);
      const result = await readActivity(
        accountId,
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
        setFailure(
          result.failure.status === 403
            ? 'denied'
            : result.failure.code === 'validation.failed'
              ? 'invalid'
              : 'unavailable',
        );
        return;
      }
      setAnswer(result.body);
    },
    [accountId, csrfToken, paging],
  );

  useEffect(() => {
    void load(query);
  }, [load, query]);

  // Panel loading L2: skeleton rows on the first load, dimmed rows on a later one.
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
      fetch(`/api/customers/admin/customers/${encodeURIComponent(accountId)}/activity/export`, {
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
          `customer-activity-${day}.xlsx`,
        );
        return;
      }
      saveFile(
        new Blob([await response.text()], { type: 'text/csv;charset=utf-8' }),
        `customer-activity-${day}.csv`,
      );
    })();
    try {
      await toast.promise(
        work,
        {
          pending: t('export.pending'),
          success: () => t('export.done'),
          error: (error: unknown) =>
            error instanceof ExportFailure
              ? t(`export.error.${error.key}`, error.values)
              : t('export.error.unavailable'),
        },
        { id: 'customer-activity-export' },
      );
    } catch {
      // The toast says what went wrong.
    } finally {
      setExporting(false);
    }
  }

  const filtered = query.from !== '' || query.to !== '';
  const chips = [
    ...(query.from === ''
      ? []
      : [{ key: 'from', label: t('chip.from', { day: query.from }), patch: { from: '' } }]),
    ...(query.to === ''
      ? []
      : [{ key: 'to', label: t('chip.to', { day: query.to }), patch: { to: '' } }]),
  ];
  const total =
    answer === null
      ? 0
      : (answer.total ??
        (answer.page - 1) * answer.pageSize + answer.items.length + (answer.hasNext ? 1 : 0));
  const start = answer === null ? 0 : (answer.page - 1) * answer.pageSize;

  const optional = (id: Optional): SuperColumn<ActivityEntry> =>
    id === 'actor'
      ? { id, header: t('col.actor'), cell: (entry) => actorOf(entry, t) }
      : {
          id,
          header: t('col.detail'),
          cell: (entry) =>
            entry.ref === null ? (
              <span className="text-fg-muted">—</span>
            ) : (
              <span className="font-mono text-xs wrap-anywhere">
                {t(
                  `ref.${['order', 'refund', 'group', 'note'].includes(entry.ref.type) ? entry.ref.type : 'other'}`,
                )}{' '}
                {entry.ref.id.slice(0, 8)}
              </span>
            ),
        };
  const tableColumns: SuperColumn<ActivityEntry>[] = [
    {
      id: 'event',
      header: t('col.event'),
      primary: true,
      headClassName: 'min-w-56',
      cell: (entry) => (
        <span className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 text-fg-secondary" aria-hidden="true">
            <Icon name={ICON[entry.category] ?? 'info'} />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="wrap-anywhere">{text(entry)}</span>
            <span className="text-xs text-fg-muted">
              {t(
                `category.${(ACTIVITY_CATEGORIES as readonly string[]).includes(entry.category) ? entry.category : 'other'}`,
              )}
            </span>
          </span>
        </span>
      ),
    },
    ...columns.map(optional),
    {
      id: 'time',
      header: t('col.time'),
      cell: (entry) => timeOf(entry.occurredAt, locale, zone),
    },
  ];
  const rowItems = (entry: ActivityEntry): MenuItem[] => {
    const href = activityHref(entry, accountId);
    return href === null
      ? [{ id: 'none', label: t('row.nothing-to-open'), disabled: true, onSelect: () => undefined }]
      : [{ id: 'open', label: t('row.open'), onSelect: () => window.location.assign(href) }];
  };

  return (
    <SuperList
      heading={{
        subtitle: t('subtitle'),
        actions: keys.has(EXPORT_PERMISSION) ? (
          <Button
            variant="secondary"
            disabled={exporting || total === 0}
            onClick={() => setExportOpen(true)}
          >
            {t('export.button')}
          </Button>
        ) : undefined,
      }}
      views={{
        label: t('views'),
        activeId: query.view,
        onSelect: (id) => list.openView(id),
        items: VIEWS.map((view) => ({ id: view, label: t(`view.${view}`) })),
        manage: null,
      }}
      filter={{
        label: t('filter.button'),
        count: chips.length,
        panel: (close) => (
          <DayRangePanel
            from={query.from}
            to={query.to}
            onApply={(from, to) => list.change({ from, to })}
            close={close}
          />
        ),
      }}
      sort={{
        label: tl('sort.button'),
        panel: () => (
          <ListSortPanel
            name="customer-activity-sort"
            sort="time"
            direction={query.direction}
            fields={[{ id: 'time', label: t('col.time') }]}
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
            columns={columns}
            optional={OPTIONAL}
            defaults={DEFAULT_OPTIONAL}
            fixed={[
              { id: 'event', label: t('col.event') },
              { id: 'time', label: t('col.time') },
            ]}
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
              const clean = next.filter((id): id is Optional =>
                (OPTIONAL as readonly string[]).includes(id),
              );
              setColumns(clean);
              writeIds(browserStorage(), storageKey, clean);
            }}
            close={close}
          />
        ),
      }}
      sortedLine={t('sorted', {
        order: query.direction === 'desc' ? tl('sort.date.first') : tl('sort.date.second'),
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
                onClick: () => list.change({ from: '', to: '' }),
              },
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
          : {
              message: t(`error.${failure}`),
              ...(failure === 'unavailable'
                ? { retry: { label: t('retry'), onClick: () => void load(query) } }
                : {}),
            }
      }
      firstLoadError={answer === null && failure === 'unavailable'}
      loading={loading}
      status={status}
      loadingLabel={t('loading')}
      slowLabel={tload('slow')}
      ready={answer !== null}
      table={
        <SuperTable
          caption={t('caption')}
          rows={answer?.items ?? []}
          rowId={(entry) => entry.entryId}
          rowName={text}
          columns={tableColumns}
          actions={{
            header: tl('col.actions'),
            label: (name) => t('row.menu', { name }),
            items: rowItems,
          }}
          empty={
            <EmptyState
              size="compact"
              icon={filtered || query.view !== 'all' ? 'search' : 'clock'}
              title={filtered || query.view !== 'all' ? t('empty-filtered') : t('empty')}
              action={
                filtered ? (
                  <Button variant="secondary" onClick={() => list.change({ from: '', to: '' })}>
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
              maxRows: ACTIVITY_MAX_ROWS,
              range:
                answer.total === null
                  ? t('range-open', {
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
            body: t('export.body'),
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
  );
}

/** The day range of the activity filter (days in the admin's zone, both ends included). */
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
  const t = useTranslations('customers.activity.filter');
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
