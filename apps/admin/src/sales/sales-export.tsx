'use client';

import {
  ExportDialog,
  saveFile,
  toast,
  type ActionMenuItem,
  type ExportFormat,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { numberFormat } from '../shared/intl.ts';

// The Export of the three Sales lists (Shipments, Refunds, Invoices; Reza's spec 0.8). Each list's
// Bulk action menu has Export as its only item; this is the part they share: the query that asks
// GET ordering/admin/{shipments|refunds|documents}/export for the file, the download through the
// panel's own relay, and the toast that says how it went.

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The keys of the list query that name a page: the file has all rows. */
const PAGING_KEYS = ['page', 'pageSize', 'cursor', 'limit'] as const;
/** The keys that name an order: dropped too, unless the export keeps the list's order. */
const ORDER_KEYS = ['sort', 'direction'] as const;

/** The rows the Bulk action menu acts on: the ticked ones, or, after "Select all", the filter. */
export interface ExportSelection {
  readonly ids: readonly string[];
  readonly allMatching: boolean;
  /** Rows the tab, search and filters match; null with Previous and next. */
  readonly total: number | null;
}

/**
 * The query of the export: the list's own filter keys exactly as the list sends them (`listQuery`,
 * the list's query string), without paging or sort (the sort stays with `keepOrder`, for an export
 * that writes the rows in the list's order); then `format`, `columns` (the visible columns,
 * in the shown order; the server adds the fixed ones), `zone`, and `ids` when rows are ticked and
 * "Select all matching" is not on (with it on, the filter alone says which rows).
 */
export function exportQuery(input: {
  readonly listQuery: string;
  readonly format: ExportFormat;
  readonly columns: readonly string[];
  readonly zone: string;
  readonly selection: ExportSelection;
  /** A list whose export has no `zone` key (its cells hold no times of day) leaves it out. */
  readonly omitZone?: boolean;
  readonly keepOrder?: boolean;
}): string {
  const params = new URLSearchParams(input.listQuery);
  for (const key of PAGING_KEYS) params.delete(key);
  if (input.keepOrder !== true) for (const key of ORDER_KEYS) params.delete(key);
  params.set('format', input.format);
  // No optional column shown: the key is left out and the file has its fixed columns.
  if (input.columns.length > 0) params.set('columns', input.columns.join(','));
  if (input.omitZone !== true) params.set('zone', input.zone);
  if (!input.selection.allMatching) {
    // An empty `ids` would be refused by the relay, and dropping it would widen the file to the
    // whole filter: with nothing ticked and "Select all matching" off there is nothing to export.
    if (input.selection.ids.length === 0) throw new Error('export.no-rows-selected');
    params.set('ids', input.selection.ids.join(','));
  }
  return params.toString();
}

/** Why an export failed, as the toast words it (one message per cause). */
export class ExportFailure extends Error {
  constructor(
    readonly reason: 'too-large' | 'too-broad' | 'denied' | 'invalid' | 'unavailable',
    readonly max: number | null = null,
    readonly total: number | null = null,
  ) {
    super(reason);
  }
}

interface ErrorBody {
  readonly code?: string;
  readonly details?: {
    readonly max?: number;
    readonly total?: number;
    readonly fields?: readonly { readonly path?: string; readonly code?: string }[];
  };
}

function failureOf(status: number, body: ErrorBody | null): ExportFailure {
  if (status === 413 && body?.code === 'batch.too-large') {
    return new ExportFailure('too-large', body.details?.max ?? null, body.details?.total ?? null);
  }
  if (status === 401 || status === 403) return new ExportFailure('denied');
  if (status === 400) {
    const tooBroad = body?.details?.fields?.some(
      (field) => field.path === 'search' && field.code === 'too-broad',
    );
    return new ExportFailure(tooBroad === true ? 'too-broad' : 'invalid');
  }
  return new ExportFailure('unavailable');
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

/** Removes the path separators from a name the server sent, so a file cannot name a folder. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[/\\]/g, '').trim();
  return cleaned === '' ? '' : cleaned;
}

/** The day in the list's zone, for the name of a file the server did not name. */
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

/**
 * Fetches the file through the relay and hands it to the browser. Resolves to the number of rows in
 * it, or null when that is not known (a workbook, with a count the list does not have).
 */
export async function downloadSalesExport(input: {
  readonly path: string;
  readonly query: string;
  readonly format: ExportFormat;
  readonly fallbackName: string;
  readonly zone: string;
  readonly knownRows: number | null;
}): Promise<number | null> {
  let response: Response;
  try {
    response = await fetch(`/api/${input.path}?${input.query}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ExportFailure('unavailable');
  }
  if (!response.ok) {
    const body = (await response.json().catch((): unknown => null)) as ErrorBody | null;
    throw failureOf(response.status, body);
  }
  // A response that is not the file asked for (an HTML error page from a proxy, say) is not saved.
  const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== (input.format === 'xlsx' ? XLSX_TYPE : 'text/csv')) {
    throw new ExportFailure('unavailable');
  }
  const named = safeFileName(
    /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? '',
  );
  const name = named === '' ? `${input.fallbackName}-${dayIn(input.zone)}.${input.format}` : named;
  try {
    if (input.format === 'xlsx') {
      saveFile(new Blob([await response.arrayBuffer()], { type: XLSX_TYPE }), name);
      return input.knownRows;
    }
    const text = await response.text();
    saveFile(new Blob([text], { type: 'text/csv;charset=utf-8' }), name);
    return csvRecords(text);
  } catch {
    // The connection broke while the file was streaming: nothing was saved.
    throw new ExportFailure('unavailable');
  }
}

/**
 * The Export item of a Sales list's Bulk action menu, and the dialog it opens: CSV or XLSX, then
 * one toast that follows the download (the rows exported, or what went wrong: too many rows, a
 * search too broad, no access, or the service down). `item` goes into the menu's items, `dialog`
 * is rendered next to the menu.
 */
export function useSalesExport(input: {
  /** `ordering/admin/shipments/export`, `.../refunds/export` or `.../documents/export`. */
  readonly path: string;
  /** The file name start when the server names none, such as `shipments`. */
  readonly fallbackName: string;
  readonly listQuery: string;
  readonly columns: readonly string[];
  readonly zone: string;
  readonly selection: ExportSelection;
  readonly omitZone?: boolean;
  /** The file keeps the list's sort (`sort` and `direction` of `listQuery`). */
  readonly keepOrder?: boolean;
}): { readonly item: ActionMenuItem; readonly dialog: ReactNode; readonly busy: boolean } {
  const t = useTranslations('sales-lists.export');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { selection } = input;
  const count = selection.allMatching ? selection.total : selection.ids.length;
  // Rows ticked is the only way to name them when "Select all matching" is off.
  const nothingToExport = !selection.allMatching && selection.ids.length === 0;
  const number = (value: number) => numberFormat(locale, {}).format(value);

  function failureText(reason: unknown): string {
    if (reason instanceof ExportFailure) {
      if (reason.reason === 'too-large') {
        return reason.max === null || reason.total === null
          ? t('error.too-large-plain')
          : t('error.too-large', { max: number(reason.max), total: number(reason.total) });
      }
      return t(`error.${reason.reason}`);
    }
    return t('error.unavailable');
  }

  async function start(format: ExportFormat) {
    if (nothingToExport) return;
    setBusy(true);
    const work = downloadSalesExport({
      path: input.path,
      query: exportQuery({
        listQuery: input.listQuery,
        format,
        columns: input.columns,
        zone: input.zone,
        selection,
        ...(input.omitZone === true ? { omitZone: true } : {}),
        ...(input.keepOrder === true ? { keepOrder: true } : {}),
      }),
      format,
      fallbackName: input.fallbackName,
      zone: input.zone,
      knownRows: count,
    });
    try {
      await toast.promise(
        work,
        {
          pending: t('pending'),
          success: (rows) => (rows === null ? t('done-unknown') : t('done', { count: rows })),
          error: failureText,
        },
        { id: 'sales-export' },
      );
    } catch {
      // The toast says what went wrong.
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    item: {
      id: 'export',
      label: t('menu'),
      description: t('menu-help'),
      icon: 'download' as const,
      disabled: nothingToExport,
      onSelect: () => setOpen(true),
    },
    dialog: (
      <ExportDialog
        open={open}
        onClose={() => setOpen(false)}
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
          setOpen(false);
          void start(format);
        }}
      />
    ),
  };
}
