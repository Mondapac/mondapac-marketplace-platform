'use client';

import { ActionMenu, ExportDialog, saveFile, toast, type ExportFormat } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { numberFormat } from '../shared/intl.ts';
import { ExportFailure, csvRecords, safeFileName } from '../sales/sales-export.tsx';
import {
  SELECT_MAX,
  exportColumns,
  selectorBody,
  type OptionalColumn,
  type Query,
} from './seller-list-query.ts';
import { SELLER_EXPORT_PATH } from './types.ts';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The rows the Bulk action menu acts on: the ticked ones, or, after "Select all", the filter. */
export interface SellersSelection {
  readonly ids: readonly string[];
  readonly allMatching: boolean;
  /** Rows the view, search and filters match; null with Previous and next. */
  readonly total: number | null;
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
    return new ExportFailure(body?.code === 'search.too-broad' ? 'too-broad' : 'invalid');
  }
  return new ExportFailure('unavailable');
}

/**
 * The request body of an export: the ticked ids alone (comma-separated, at most 200), or after
 * "Select all matching" the list's selector and sort, never both (the API refuses a mix). The
 * owner's name and email are never in a file, so no column asks for them.
 */
export function exportBody(input: {
  readonly format: ExportFormat;
  readonly selection: SellersSelection;
  readonly query: Query;
  readonly columns: readonly OptionalColumn[];
}): Record<string, unknown> {
  const columns = exportColumns(input.columns);
  return {
    format: input.format,
    ...(columns === '' ? {} : { columns }),
    ...(input.selection.allMatching
      ? selectorBody(input.query)
      : { ids: input.selection.ids.join(',') }),
  };
}

async function download(input: {
  readonly csrfToken: string;
  readonly format: ExportFormat;
  readonly body: Record<string, unknown>;
  readonly knownRows: number | null;
}): Promise<number | null> {
  let response: Response;
  try {
    response = await fetch(`/api/${SELLER_EXPORT_PATH}`, {
      method: 'POST',
      headers: {
        accept: 'text/csv, application/json',
        'content-type': 'application/json',
        'x-csrf-token': input.csrfToken,
      },
      body: JSON.stringify(input.body),
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
  // A response that is not the file asked for (an HTML error page from a proxy) is not saved.
  const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== (input.format === 'xlsx' ? XLSX_TYPE : 'text/csv')) {
    throw new ExportFailure('unavailable');
  }
  const named = safeFileName(
    /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? '',
  );
  const name =
    named === '' ? `sellers-${new Date().toISOString().slice(0, 10)}.${input.format}` : named;
  try {
    if (input.format === 'xlsx') {
      saveFile(new Blob([await response.arrayBuffer()], { type: XLSX_TYPE }), name);
      return input.knownRows;
    }
    const text = await response.text();
    saveFile(new Blob([text], { type: 'text/csv;charset=utf-8' }), name);
    return csvRecords(text);
  } catch {
    throw new ExportFailure('unavailable');
  }
}

/**
 * The Bulk action button of the Sellers header. The seller's decision (approve, reject) stays on
 * the seller's own page, so the one item is Export: a CSV or XLSX file of the ticked sellers (up to
 * 200) or, after "Select all matching", of every seller the view, search and filters match, in the
 * list's sort. The button is disabled until a row is selected.
 */
export function SellersBulk({
  selection,
  query,
  columns,
  csrfToken,
}: {
  readonly selection: SellersSelection;
  readonly query: Query;
  readonly columns: readonly OptionalColumn[];
  readonly csrfToken: string;
}) {
  const t = useTranslations('sellers.list.bulk');
  const te = useTranslations('sales-lists.export');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const count = selection.allMatching ? selection.total : selection.ids.length;
  const selected = selection.allMatching || selection.ids.length > 0;
  const number = (value: number) => numberFormat(locale, {}).format(value);

  function failureText(reason: unknown): string {
    if (reason instanceof ExportFailure) {
      if (reason.reason === 'too-large') {
        return reason.max === null || reason.total === null
          ? te('error.too-large-plain')
          : te('error.too-large', { max: number(reason.max), total: number(reason.total) });
      }
      return te(`error.${reason.reason}`);
    }
    return te('error.unavailable');
  }

  async function start(format: ExportFormat) {
    if (!selected) return;
    if (!selection.allMatching && selection.ids.length > SELECT_MAX) {
      toast.error(
        te('error.too-large', { max: number(SELECT_MAX), total: number(selection.ids.length) }),
        {
          id: 'sellers-export',
        },
      );
      return;
    }
    setBusy(true);
    const work = download({
      csrfToken,
      format,
      body: exportBody({ format, selection, query, columns }),
      knownRows: count,
    });
    try {
      await toast.promise(
        work,
        {
          pending: te('pending'),
          success: (rows) => (rows === null ? te('done-unknown') : te('done', { count: rows })),
          error: failureText,
        },
        { id: 'sellers-export' },
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
          selection.allMatching && selection.total === null
            ? t('all-open')
            : t('selected', { count: count ?? 0 })
        }
        items={[
          {
            id: 'export',
            label: te('menu'),
            description: te('menu-help'),
            icon: 'download' as const,
            disabled: !selected,
            onSelect: () => setOpen(true),
          },
        ]}
        disabled={!selected || busy}
      />
      <ExportDialog
        open={open}
        onClose={() => setOpen(false)}
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
          setOpen(false);
          void start(format);
        }}
      />
    </>
  );
}
