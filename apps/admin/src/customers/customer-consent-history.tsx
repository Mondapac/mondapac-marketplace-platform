'use client';

import {
  Badge,
  Button,
  EmptyState,
  ExportDialog,
  ListColumnsPanel,
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
  useSuperListQuery,
  writeIds,
  type ExportFormat,
  type SuperColumn,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import { numberFormat } from '../shared/intl.ts';
import { useStepUpProof } from '../step-up/step-up.tsx';
import { timeOf } from './format.ts';
import { ACTIVITY_MAX_ROWS } from './groups-types.ts';
import { EXPORT_PERMISSION } from './list-types.ts';
import type { ConsentChange, SectionPage } from './security-types.ts';

const PAGE_SIZES = [25, 50, 100] as const;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const OPTIONAL = ['source'] as const;
type Optional = (typeof OPTIONAL)[number];
const DEFAULT_OPTIONAL: readonly Optional[] = ['source'];

interface Query {
  readonly direction: 'asc' | 'desc';
  readonly page: number;
  readonly pageSize: number;
}
const DEFAULT_QUERY: Query = { direction: 'desc', page: 1, pageSize: 25 };

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
 * The changes of a customer's marketing consent as a super list (customers management phase 2b,
 * Privacy): time, channel, granted or withdrawn and its source; the sort by time, the column
 * picker, Export (CSV or XLSX behind the export key and a fresh two-step code) and the footer of
 * the Market's List paging setting. The API filters only by channel (one value today), and has no
 * search, saved filters or selection: recorded as rule 14 exceptions in the PR.
 */
export function CustomerConsentHistory({
  accountId,
  adminAccountId,
  marketId,
  keys,
  csrfToken,
  zone,
  paging,
  onHidden,
}: {
  readonly accountId: string;
  readonly adminAccountId: string;
  readonly marketId: string;
  readonly keys: ReadonlySet<string>;
  readonly csrfToken: string;
  readonly zone: string;
  readonly paging: 'pages' | 'prev-next';
  readonly onHidden: () => void;
}) {
  const t = useTranslations('customers.security.consent-history');
  const ts = useTranslations('customers.security');
  const tl = useTranslations('customers.list');
  const tload = useTranslations('load');
  const locale = useLocale();
  const prove = useStepUpProof();
  const [answer, setAnswer] = useState<SectionPage<ConsentChange> | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<'unavailable' | null>(null);
  const [columns, setColumns] = useState<readonly Optional[]>(DEFAULT_OPTIONAL);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const latest = useRef(0);
  const storageKey = prefsKey(
    'admin',
    marketId,
    adminAccountId,
    'customer-consent-history-columns',
  );

  const list = useSuperListQuery<Query>({
    defaultQuery: DEFAULT_QUERY,
    forView: () => DEFAULT_QUERY,
    withView: (current) => current,
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
      const result = await callApi<SectionPage<ConsentChange>>(
        'POST',
        `customers/admin/customers/${encodeURIComponent(accountId)}/consent-history`,
        { direction: next.direction, page: next.page, pageSize: next.pageSize, paging },
        csrfToken,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        if (result.failure.status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        if (result.failure.status === 403) {
          onHidden();
          return;
        }
        setFailure('unavailable');
        return;
      }
      setAnswer(result.body);
    },
    [accountId, csrfToken, paging, onHidden],
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
    const body = { format, direction: query.direction };
    const send = () =>
      fetch(
        `/api/customers/admin/customers/${encodeURIComponent(accountId)}/consent-history/export`,
        {
          method: 'POST',
          headers: {
            accept: 'text/csv, application/json',
            'content-type': 'application/json',
            'x-csrf-token': csrfToken,
          },
          body: JSON.stringify(body),
          credentials: 'same-origin',
          cache: 'no-store',
        },
      );
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
          `customer-consent-history-${day}.xlsx`,
        );
        return;
      }
      saveFile(
        new Blob([await response.text()], { type: 'text/csv;charset=utf-8' }),
        `customer-consent-history-${day}.csv`,
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
        { id: 'customer-consent-history-export' },
      );
    } catch {
      // The toast says what went wrong.
    } finally {
      setExporting(false);
    }
  }

  const numberOf = (value: number) => numberFormat(locale, {}).format(value);
  const total =
    answer === null
      ? 0
      : (answer.total ??
        (answer.page - 1) * answer.pageSize + answer.items.length + (answer.hasNext ? 1 : 0));
  const start = answer === null ? 0 : (answer.page - 1) * answer.pageSize;
  const channelText = (channel: string) => (channel === 'email' ? ts('channel.email') : channel);
  const sourceText = (source: string) =>
    ['sign-up', 'account', 'unsubscribe-link'].includes(source) ? t(`source.${source}`) : source;
  const rowName = (row: ConsentChange) =>
    t('row.name', { time: timeOf(row.occurredAt, locale, zone) });

  const tableColumns: SuperColumn<ConsentChange>[] = [
    {
      id: 'time',
      header: t('col.time'),
      primary: true,
      headClassName: 'min-w-48',
      cell: (row) => timeOf(row.occurredAt, locale, zone),
    },
    { id: 'channel', header: t('col.channel'), cell: (row) => channelText(row.channel) },
    {
      id: 'change',
      header: t('col.change'),
      cell: (row) => (
        <Badge tone={row.granted ? 'success' : 'neutral'}>
          {row.granted ? t('granted') : t('withdrawn')}
        </Badge>
      ),
    },
    ...columns.map((id): SuperColumn<ConsentChange> => ({
      id,
      header: t('col.source'),
      cell: (row) => sourceText(row.source),
    })),
  ];

  return (
    <SuperList
      heading={{
        embedded: true,
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
        activeId: 'all',
        onSelect: () => list.openView('all'),
        items: [{ id: 'all', label: t('view.all') }],
        manage: null,
      }}
      sort={{
        label: tl('sort.button'),
        panel: () => (
          <ListSortPanel
            name="customer-consent-history-sort"
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
              { id: 'time', label: t('col.time') },
              { id: 'channel', label: t('col.channel') },
              { id: 'change', label: t('col.change') },
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
      chips={null}
      failure={
        failure === null
          ? null
          : {
              message: t('error.unavailable'),
              retry: { label: ts('retry'), onClick: () => void load(query) },
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
          rowId={(row) => `${row.occurredAt}-${row.channel}`}
          rowName={rowName}
          columns={tableColumns}
          empty={<EmptyState size="compact" icon="clock" title={t('empty')} />}
          skeletonRows={skeleton ? listSkeletonRowCount(query.pageSize) : undefined}
          minWidthClass="lg:min-w-140"
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
