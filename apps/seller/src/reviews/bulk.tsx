'use client';

import {
  ActionMenu,
  Button,
  ExportDialog,
  Icon,
  saveFile,
  toast,
  type ActionMenuItem,
  type ExportFormat,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { resolveZone } from '../price/zone-time.ts';
import { numberFormat } from '../shared/intl.ts';
import { dayInZone } from '../catalog/products-export.tsx';
import type { ReviewColumn } from './columns.ts';
import { selectorParams, type Query } from './query.ts';

/** The rows the Bulk action menu acts on: the ticked ones, or, after "Select all", the whole filter. */
export interface BulkSelection {
  readonly ids: readonly string[];
  readonly allMatching: boolean;
  /** Reviews the current tab, search and filters match; null with Previous and next. */
  readonly total: number | null;
}

class ExportFailure extends Error {
  constructor(
    readonly key: string,
    readonly values: Record<string, number> = {},
  ) {
    super(key);
  }
}

/** Which refusal of GET reviews/seller/export this is. */
export function exportFailure(
  status: number,
  code: string,
  details: { readonly max?: number; readonly total?: number } | null,
): { readonly key: string; readonly values: Record<string, number> } {
  if (code === 'batch.too-large') {
    // The id cap names no total; the row cap names both.
    return details?.total === undefined
      ? { key: 'too-many-selected', values: { max: details?.max ?? 0 } }
      : { key: 'too-large', values: { max: details.max ?? 0, total: details.total } };
  }
  if (code === 'validation.failed') return { key: 'invalid', values: {} };
  if (code === 'reviews.not-found' || status === 404) return { key: 'not-found', values: {} };
  if (status === 401 || status === 403) return { key: 'denied', values: {} };
  return { key: 'unavailable', values: {} };
}

/** The export request's query: the rows asked for, the file format and the columns shown. */
export function exportQuery(
  format: ExportFormat,
  query: Query,
  columns: readonly ReviewColumn[],
  ids: readonly string[] | null,
): string {
  // The stars, title, text and published time are always in the file; the optional columns follow
  // the details the list shows. The list's paging keys are refused by the API, so they are not sent.
  const shown = [
    ...(columns.includes('product') ? ['product-id'] : []),
    ...(columns.includes('order') ? ['order-ref'] : []),
    ...(columns.includes('reply') ? ['reply', 'replied'] : []),
  ];
  const params = ids === null ? selectorParams(query) : new URLSearchParams();
  params.set('sort', query.sort);
  params.set('direction', query.direction);
  params.set('format', format);
  if (shown.length > 0) params.set('columns', shown.join(','));
  if (ids !== null) params.set('ids', ids.join(','));
  return params.toString();
}

const MIME: Record<ExportFormat, string> = {
  csv: 'text/csv;charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * The Export button of the page header (the whole filter) and the Bulk action menu beside it (the
 * ticked rows; its only item is Export). Both open the same dialog, which asks for the file format
 * (CSV or XLSX). The API answers the file in the same request, so there is no "notify me later": a
 * toast says "Preparing your export…" while it downloads, then the file is saved. Over 10,000
 * reviews, or with more than 200 ticked, the answer is a refusal that says so.
 */
export function ReviewsBulk({
  selection,
  query,
  columns,
  total,
  timeZone,
}: {
  readonly selection: BulkSelection;
  readonly query: Query;
  readonly columns: readonly ReviewColumn[];
  /** Reviews the current list matches; null with Previous and next. */
  readonly total: number | null;
  /** The seller's own zone, or null when none was chosen (the file's date is then in the fallback zone). */
  readonly timeZone: string | null;
}) {
  const t = useTranslations('reviews.list');
  const locale = useLocale();
  const [dialog, setDialog] = useState<'filter' | 'selected' | null>(null);
  const [busy, setBusy] = useState(false);

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const selectedCount = selection.allMatching ? (selection.total ?? 0) : selection.ids.length;
  const anySelected = selection.allMatching || selection.ids.length > 0;

  async function download(
    format: ExportFormat,
    ids: readonly string[] | null,
    rows: number | null,
  ) {
    setBusy(true);
    const work = (async (): Promise<number | null> => {
      let response: Response;
      try {
        response = await fetch(
          `/api/reviews/seller/export?${exportQuery(format, query, columns, ids)}`,
          { credentials: 'same-origin', cache: 'no-store' },
        );
      } catch {
        throw new ExportFailure('unavailable');
      }
      if (response.status === 401) {
        window.location.assign('/session-ended');
        throw new ExportFailure('denied');
      }
      if (!response.ok) {
        const body = (await response.json().catch((): unknown => null)) as {
          code?: string;
          details?: Parameters<typeof exportFailure>[2];
        } | null;
        const failure = exportFailure(
          response.status,
          body?.code ?? 'unknown',
          body?.details ?? null,
        );
        throw new ExportFailure(failure.key, failure.values);
      }
      // The file is named for the seller's own day (ADR-0005), not the UTC one.
      const day = dayInZone(new Date(), resolveZone(timeZone));
      saveFile(
        new Blob([await response.arrayBuffer()], { type: MIME[format] }),
        `reviews-${day}.${format}`,
      );
      return rows;
    })();
    try {
      await toast.promise(
        work,
        {
          pending: t('export.pending'),
          success: (done) =>
            done === null ? t('export.done-open') : t('export.done', { count: done }),
          error: (reason) =>
            reason instanceof ExportFailure
              ? t(`export.error.${reason.key}`, {
                  max: number(reason.values['max'] ?? 0),
                  total: number(reason.values['total'] ?? 0),
                })
              : t('export.error.unavailable'),
        },
        { id: 'reviews-export' },
      );
    } catch {
      // The toast says what went wrong.
    } finally {
      setBusy(false);
    }
  }

  const items: ActionMenuItem[] = [
    {
      id: 'export',
      label: t('bulk.export'),
      description: t('bulk.export-help'),
      icon: 'download',
      onSelect: () => setDialog('selected'),
    },
  ];
  const count =
    dialog === 'selected'
      ? selection.allMatching
        ? selection.total
        : selection.ids.length
      : total;

  return (
    <>
      <Button
        variant="secondary"
        className="gap-2"
        disabled={busy || total === 0}
        onClick={() => setDialog('filter')}
      >
        <Icon name="download" />
        {t('export-button')}
      </Button>
      <ActionMenu
        label={t('bulk.button')}
        title={
          selection.allMatching && selection.total === null
            ? t('bulk.all-open')
            : t('bulk.selected', { count: selectedCount })
        }
        items={items}
        disabled={!anySelected || busy}
        {...(anySelected ? {} : { hint: t('bulk.none-selected') })}
      />
      <ExportDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        busy={busy}
        labels={{
          title: count === null ? t('export.title-open') : t('export.title', { count }),
          body: t('export.body'),
          legend: t('export.legend'),
          csv: t('export.csv'),
          csvHelp: t('export.csv-help'),
          xlsx: t('export.xlsx'),
          xlsxHelp: t('export.xlsx-help'),
          confirm: t('export.confirm'),
          cancel: t('export.cancel'),
        }}
        onConfirm={(format) => {
          const target = dialog;
          setDialog(null);
          if (target === 'selected' && !selection.allMatching) {
            void download(format, selection.ids, selection.ids.length);
          } else {
            void download(format, null, target === 'selected' ? selection.total : total);
          }
        }}
      />
    </>
  );
}
