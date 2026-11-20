'use client';

import { ActionMenu, ExportDialog, saveFile, toast, type ExportFormat } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { csvRecords } from '../../orders/orders-export.tsx';
import { numberFormat } from '../../shared/intl.ts';
import type { ListPaging } from '../payout-types.ts';
import { exportColumnsOf, type OptionalColumn } from './payouts-columns.ts';
import { SELECTION_MAX, type Query } from './payouts-list-types.ts';
import { selectorParams } from './payouts-query.ts';

// The Export of the seller Earnings payout list (kit export dialog: CSV or XLSX), the one bulk
// action: money never moves in bulk. It asks GET commission-payouts/seller/payouts/export for the
// file through the panel's own relay and says how it went. Without the optional columns the file
// has Payout ID, Status, Amount, Currency and Payout on.

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PATH = 'commission-payouts/seller/payouts/export';

/** The rows the Bulk action menu acts on: the ticked ones, or, after "Select all", the filter. */
export interface PayoutSelection {
  readonly ids: readonly string[];
  readonly allMatching: boolean;
  /** Payouts the view, search and filters match; null with Previous and next. */
  readonly total: number | null;
}

/**
 * The export request's query. Ticked rows go by id alone (the API ignores a filter beside `ids`);
 * "Select all matching" sends the list's selector keys and its sort (Previous and next lists the
 * latest payout day first, or the newest planned day first, so the file keeps the order on screen).
 * `columns` are the optional columns shown that the file has, in the shown order.
 */
export function exportParams(input: {
  readonly query: Query;
  readonly paging: ListPaging;
  readonly zone: string;
  readonly exponent: number;
  readonly format: ExportFormat;
  readonly columns: readonly OptionalColumn[];
  readonly selection: PayoutSelection;
  /** When the rows on show were read: the day presets are read on this clock. */
  readonly now: Date;
}): string {
  const { selection, query } = input;
  const params = new URLSearchParams();
  if (selection.allMatching) {
    for (const [key, value] of selectorParams(query, {
      paging: input.paging,
      zone: input.zone,
      now: input.now,
      exponent: input.exponent,
    })) {
      params.set(key, value);
    }
    params.set('sort', input.paging === 'pages' || query.sort !== 'amount' ? query.sort : 'slot');
    params.set('direction', input.paging === 'pages' ? query.direction : 'desc');
  } else {
    if (selection.ids.length === 0) throw new Error('export.no-rows-selected');
    params.set('ids', selection.ids.slice(0, SELECTION_MAX).join(','));
  }
  params.set('format', input.format);
  const columns = exportColumnsOf(input.columns);
  if (columns.length > 0) params.set('columns', columns.join(','));
  return params.toString();
}

type Reason =
  'too-large' | 'too-many-selected' | 'denied' | 'invalid' | 'not-found' | 'zone' | 'unavailable';

/** Why an export failed, as the toast words it (one message per cause). */
export class ExportFailure extends Error {
  constructor(
    readonly reason: Reason,
    readonly max: number | null = null,
    readonly matching: number | null = null,
  ) {
    super(reason);
  }
}

interface ErrorBody {
  readonly code?: string;
  readonly details?: { readonly max?: number; readonly matching?: number; readonly total?: number };
}

function failureOf(status: number, body: ErrorBody | null): ExportFailure {
  if (status === 413 && body?.code === 'batch.too-large') {
    const total = body.details?.total ?? body.details?.matching ?? null;
    return new ExportFailure(
      total === null ? 'too-many-selected' : 'too-large',
      body.details?.max ?? null,
      total,
    );
  }
  if (status === 401 || status === 403) return new ExportFailure('denied');
  if (status === 404) return new ExportFailure('not-found');
  // The store's time zone could not be read, so the file's dates cannot be written.
  if (status === 503 && body?.code === 'commission-payouts.unavailable') {
    return new ExportFailure('zone');
  }
  return new ExportFailure(status === 400 ? 'invalid' : 'unavailable');
}

/** The day in the store's zone, for the name of the file. */
function dayIn(zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Fetches the file and hands it to the browser; resolves to the rows in it, or null if unknown. */
async function download(
  query: string,
  format: ExportFormat,
  zone: string,
  knownRows: number | null,
): Promise<number | null> {
  let response: Response;
  try {
    response = await fetch(`/api/${PATH}?${query}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ExportFailure('unavailable');
  }
  if (response.status === 401) {
    window.location.assign('/session-ended');
    throw new ExportFailure('denied');
  }
  if (!response.ok) {
    const body = (await response.json().catch((): unknown => null)) as ErrorBody | null;
    throw failureOf(response.status, body);
  }
  // A response that is not the file asked for (an HTML error page from a proxy) is not saved.
  const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== (format === 'xlsx' ? XLSX_TYPE : 'text/csv')) throw new ExportFailure('unavailable');
  const name = `payouts-${dayIn(zone)}.${format}`;
  try {
    if (format === 'xlsx') {
      saveFile(new Blob([await response.arrayBuffer()], { type: XLSX_TYPE }), name);
      return knownRows;
    }
    // Save the API's own bytes (its CSV byte-order mark must survive); count rows from a copy.
    const bytes = await response.arrayBuffer();
    saveFile(new Blob([bytes], { type: 'text/csv;charset=utf-8' }), name);
    return csvRecords(new TextDecoder().decode(bytes));
  } catch {
    throw new ExportFailure('unavailable');
  }
}

/**
 * The Bulk action menu of the payout list. Money is never moved in bulk, so the one item is
 * Export. The button is disabled until a row is selected; ticked rows leave by id, and after
 * "Select all matching" the file holds every payout the view, search and filters match.
 */
export function PayoutsBulk({
  selection,
  query,
  paging,
  zone,
  exponent,
  columns,
  readAt,
}: {
  readonly selection: PayoutSelection;
  readonly query: Query;
  readonly paging: ListPaging;
  readonly zone: string;
  readonly exponent: number;
  readonly columns: readonly OptionalColumn[];
  /** When the rows on show were read; the day presets of "all matching" use this clock. */
  readonly readAt: Date | null;
}) {
  const t = useTranslations('payouts.list.bulk');
  const te = useTranslations('payouts.list.export');
  const locale = useLocale();
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const selected = selection.allMatching || selection.ids.length > 0;
  const named = !selection.allMatching && selection.ids.length > 0;
  const count = named ? selection.ids.length : selection.total;
  const number = (value: number) => numberFormat(locale, {}).format(value);

  function failureText(reason: unknown): string {
    if (!(reason instanceof ExportFailure)) return te('error.unavailable');
    if (reason.reason === 'too-large' || reason.reason === 'too-many-selected') {
      return reason.max === null
        ? te('error.too-large-plain')
        : reason.matching === null
          ? te('error.too-many-selected', { max: number(reason.max) })
          : te('error.too-large', { max: number(reason.max), total: number(reason.matching) });
    }
    return te(`error.${reason.reason}`);
  }

  async function start(format: ExportFormat) {
    setBusy(true);
    let work: Promise<number | null>;
    try {
      work = download(
        exportParams({
          query,
          paging,
          zone,
          exponent,
          format,
          columns,
          selection,
          now: readAt ?? new Date(),
        }),
        format,
        zone,
        count,
      );
    } catch {
      work = Promise.reject(new ExportFailure('invalid'));
    }
    try {
      await toast.promise(
        work,
        {
          pending: te('pending'),
          success: (rows) => (rows === null ? te('done-unknown') : te('done', { count: rows })),
          error: failureText,
        },
        { id: 'payouts-export' },
      );
    } catch {
      // The toast says what went wrong.
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ActionMenu
        label={t('button')}
        title={
          !selected
            ? t('none-selected')
            : selection.allMatching && selection.total === null
              ? t('all-open')
              : t('selected', {
                  count: selection.allMatching ? (selection.total ?? 0) : selection.ids.length,
                })
        }
        items={[
          {
            id: 'export',
            label: t('export'),
            description: t('export-help'),
            icon: 'download',
            onSelect: () => setOpened(true),
          },
        ]}
        disabled={!selected || busy}
      />
      <ExportDialog
        open={opened}
        onClose={() => setOpened(false)}
        busy={busy}
        labels={{
          title: count === null ? te('title-all') : te('title', { count }),
          body: te('body'),
          legend: te('legend'),
          csv: te('csv'),
          csvHelp: te('csv-help'),
          xlsx: te('xlsx'),
          xlsxHelp: te('xlsx-help'),
          confirm: te('confirm'),
          cancel: te('cancel'),
        }}
        onConfirm={(format) => {
          setOpened(false);
          void start(format);
        }}
      />
    </>
  );
}
