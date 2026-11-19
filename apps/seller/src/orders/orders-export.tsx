'use client';

import { ExportDialog, saveFile, toast, type ExportFormat } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { numberFormat } from '../shared/intl.ts';
import type { OrderColumn } from './orders-columns.ts';

// The Export of the seller Orders list (kit export dialog: CSV or XLSX). The Bulk action menu holds
// the item; this is the part that asks GET ordering/seller/orders/export for the file through the
// panel's own relay and says how it went.

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PATH = 'ordering/seller/orders/export';

/**
 * The export columns the shown list columns stand for, in the shown order. Seller order, Order,
 * Paid at and Fulfilment always leave; Total brings the amounts behind it, and the carrier and the
 * step times follow because the list shows them in its status cell.
 */
export const exportColumnIds = (columns: readonly OrderColumn[]): readonly string[] => [
  ...columns.flatMap((column): readonly string[] => {
    switch (column) {
      case 'delivery':
        return ['delivery'];
      case 'items':
        return ['items'];
      case 'total':
        return ['currency', 'subtotal', 'shipping', 'tax', 'total'];
      default:
        return [];
    }
  }),
  'carrier',
  'tracking',
  'ready',
  'shipped',
  'delivered',
];

/**
 * The export request's query: the list's filter (the tab and the paid days; no search, paging or
 * sort) or, when rows are ticked, their ids alone, then `format` and `columns`.
 */
export function exportQuery(input: {
  readonly listQuery: string;
  readonly format: ExportFormat;
  readonly columns: readonly string[];
  /** The ticked seller order ids; null exports every order the filter matches. */
  readonly ids: readonly string[] | null;
}): string {
  const params = new URLSearchParams(input.ids === null ? input.listQuery : '');
  params.set('format', input.format);
  params.set('columns', input.columns.join(','));
  if (input.ids !== null) params.set('ids', input.ids.join(','));
  return params.toString();
}

type Reason =
  'too-large' | 'too-many-selected' | 'denied' | 'invalid' | 'not-found' | 'unavailable';

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
  readonly details?: { readonly max?: number; readonly matching?: number };
}

function failureOf(status: number, body: ErrorBody | null): ExportFailure {
  if (status === 413 && body?.code === 'batch.too-large') {
    return new ExportFailure(
      body.details?.matching === undefined ? 'too-many-selected' : 'too-large',
      body.details?.max ?? null,
      body.details?.matching ?? null,
    );
  }
  if (status === 401 || status === 403) return new ExportFailure('denied');
  if (status === 404) return new ExportFailure('not-found');
  return new ExportFailure(status === 400 ? 'invalid' : 'unavailable');
}

/** Records of a CSV file after its header: a line break inside quotes does not end a record. */
export function csvRecords(text: string): number {
  const body = text.replace(/^\uFEFF/, '');
  let inQuotes = false;
  let ends = 0;
  for (const char of body) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === '\n' && !inQuotes) ends += 1;
  }
  if (body !== '' && !body.endsWith('\n')) ends += 1;
  return Math.max(ends - 1, 0);
}

/** The day in the seller's zone, for the name of the file. */
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
  // The panel names the file itself: the relay does not pass the API's file name on.
  const name = `seller-orders-${dayIn(zone)}.${format}`;
  try {
    if (format === 'xlsx') {
      saveFile(new Blob([await response.arrayBuffer()], { type: XLSX_TYPE }), name);
      return knownRows;
    }
    const text = await response.text();
    saveFile(new Blob([text], { type: 'text/csv;charset=utf-8' }), name);
    return csvRecords(text);
  } catch {
    throw new ExportFailure('unavailable');
  }
}

/**
 * The Export item of the Orders Bulk action menu and the dialog it opens (CSV or XLSX), then one
 * toast that follows the download. With rows ticked the file holds exactly those; with none
 * ticked, or after "Select all matching", every order the tab and paid days match.
 */
export function useOrdersExport(input: {
  readonly listQuery: string;
  readonly columns: readonly OrderColumn[];
  /** The ticked seller order ids; empty with none ticked. */
  readonly ids: readonly string[];
  readonly allMatching: boolean;
  /** Orders the filter matches; null with Previous and next. */
  readonly total: number | null;
  readonly zone: string;
}): { readonly open: () => void; readonly dialog: ReactNode; readonly busy: boolean } {
  const t = useTranslations('orders.export');
  const locale = useLocale();
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const named = !input.allMatching && input.ids.length > 0;
  const count = named ? input.ids.length : input.total;
  const number = (value: number) => numberFormat(locale, {}).format(value);

  function failureText(reason: unknown): string {
    if (!(reason instanceof ExportFailure)) return t('error.unavailable');
    if (reason.reason === 'too-large' || reason.reason === 'too-many-selected') {
      return reason.max === null
        ? t('error.too-large-plain')
        : reason.matching === null
          ? t('error.too-many-selected', { max: number(reason.max) })
          : t('error.too-large', { max: number(reason.max), total: number(reason.matching) });
    }
    return t(`error.${reason.reason}`);
  }

  async function start(format: ExportFormat) {
    setBusy(true);
    const work = download(
      exportQuery({
        listQuery: input.listQuery,
        format,
        columns: exportColumnIds(input.columns),
        ids: named ? input.ids : null,
      }),
      format,
      input.zone,
      count,
    );
    try {
      await toast.promise(
        work,
        {
          pending: t('pending'),
          success: (rows) => (rows === null ? t('done-unknown') : t('done', { count: rows })),
          error: failureText,
        },
        { id: 'orders-export' },
      );
    } catch {
      // The toast says what went wrong.
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    open: () => setOpened(true),
    dialog: (
      <ExportDialog
        open={opened}
        onClose={() => setOpened(false)}
        busy={busy}
        labels={{
          title: count === null ? t('title-all') : t('title', { count }),
          body: t('body'),
          legend: t('legend'),
          csv: t('csv'),
          csvHelp: t('csv-help'),
          xlsx: t('xlsx'),
          xlsxHelp: t('xlsx-help'),
          confirm: t('confirm'),
          cancel: t('cancel'),
        }}
        onConfirm={(format) => {
          setOpened(false);
          void start(format);
        }}
      />
    ),
  };
}
