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
import { numberFormat } from '../shared/intl.ts';
import { FILTER_FIELDS, type OptionalColumn, type Query } from './products-list-types.ts';

/** The rows the Bulk action menu acts on: the ticked ones, or, after "Select all", the whole filter. */
export interface BulkSelection {
  readonly ids: readonly string[];
  readonly allMatching: boolean;
  /** Products the current tab, search and filters match. */
  readonly total: number;
}

/** What the export request fails with, as the toast words it (one message per cause). */
class ExportFailure extends Error {
  constructor(
    readonly key: string,
    readonly values: Record<string, number> = {},
  ) {
    super(key);
  }
}

/** Which refusal of GET catalog/seller/products/export this is (catalog design 9.2c). */
export function exportFailure(
  status: number,
  code: string,
  details: {
    readonly max?: number;
    readonly total?: number;
    readonly fields?: readonly { readonly path: string; readonly code: string }[];
  } | null,
): { readonly key: string; readonly values: Record<string, number> } {
  if (code === 'batch.too-large') {
    // The id cap names no total; the row cap names both.
    return details?.total === undefined
      ? { key: 'too-many-selected', values: { max: details?.max ?? 0 } }
      : { key: 'too-large', values: { max: details.max ?? 0, total: details.total } };
  }
  if (code === 'validation.failed') {
    return details?.fields?.some((field) => field.code === 'too-broad') === true
      ? { key: 'too-broad', values: {} }
      : { key: 'invalid', values: {} };
  }
  if (code === 'product.not-found' || status === 404) return { key: 'not-found', values: {} };
  if (status === 401 || status === 403) return { key: 'denied', values: {} };
  return { key: 'unavailable', values: {} };
}

/** The export request's query: the rows asked for, the file format and the columns shown. */
export function exportQuery(
  format: ExportFormat,
  query: Query,
  columns: readonly OptionalColumn[],
  ids: readonly string[] | null,
): string {
  const params = new URLSearchParams({ format });
  // Product, status and category are always in the file; the rest follow as shown.
  params.set('columns', ['product', ...columns].join(','));
  params.set('sort', query.sort);
  params.set('direction', query.direction);
  if (ids !== null) {
    params.set('productIds', ids.join(','));
  } else {
    params.set('view', query.view);
    if (query.q !== '') params.set('q', query.q);
    for (const field of FILTER_FIELDS) {
      const value = query.filters[field];
      if (value !== undefined) params.set(field, value);
    }
  }
  return params.toString();
}

const MIME: Record<ExportFormat, string> = {
  csv: 'text/csv;charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * The Export button of the page header (the whole filter) and the Bulk action menu beside it (the
 * ticked rows; its only item is Export). Bulk action is disabled until rows are selected, and the
 * count shows only in the open menu. Both open the same dialog, which asks for the file format
 * (CSV or XLSX) and says the shown columns are exported. The API answers the file in the same
 * request, so there is no "notify me later": a toast says "Preparing your export…" while it
 * downloads, then the file is saved. Over 10,000 products, or with more than 100 ticked, the
 * answer is a refusal that says so.
 */
export function ProductsExport({
  selection,
  query,
  columns,
  total,
  onSelectAll,
  onClear,
}: {
  readonly selection: BulkSelection;
  readonly query: Query;
  readonly columns: readonly OptionalColumn[];
  /** Products the current list matches; null until the first page loads. */
  readonly total: number | null;
  readonly onSelectAll: () => void;
  readonly onClear: () => void;
}) {
  const t = useTranslations('catalog.products');
  const locale = useLocale();
  const [dialog, setDialog] = useState<'filter' | 'selected' | null>(null);
  const [busy, setBusy] = useState(false);

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const selectedCount = selection.allMatching ? selection.total : selection.ids.length;
  const count = dialog === 'selected' ? selectedCount : (total ?? 0);

  async function download(format: ExportFormat, ids: readonly string[] | null, rows: number) {
    setBusy(true);
    const work = (async (): Promise<number> => {
      let response: Response;
      try {
        response = await fetch(
          `/api/catalog/seller/products/export?${exportQuery(format, query, columns, ids)}`,
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
      const day = new Date().toISOString().slice(0, 10);
      saveFile(
        new Blob([await response.arrayBuffer()], { type: MIME[format] }),
        `products-${day}.${format}`,
      );
      return rows;
    })();
    try {
      await toast.promise(
        work,
        {
          pending: t('export.pending'),
          success: (done) => t('export.done', { count: done }),
          error: (reason) =>
            reason instanceof ExportFailure
              ? t(`export.error.${reason.key}`, {
                  max: number(reason.values['max'] ?? 0),
                  total: number(reason.values['total'] ?? 0),
                })
              : t('export.error.unavailable'),
        },
        { id: 'products-export' },
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
      label: t('bulk.menu.export'),
      description: t('bulk.menu.export-help'),
      icon: 'download',
      onSelect: () => setDialog('selected'),
    },
  ];
  const links = [
    ...(!selection.allMatching && selection.total > selectedCount
      ? [
          {
            id: 'select-all',
            label: t('bulk.select-all', { count: selection.total }),
            onSelect: onSelectAll,
          },
        ]
      : []),
    { id: 'clear', label: t('bulk.clear'), onSelect: onClear },
  ];

  return (
    <>
      <Button
        variant="secondary"
        className="gap-2"
        disabled={busy || total === null || total === 0}
        onClick={() => setDialog('filter')}
      >
        <Icon name="download" />
        {t('export-button')}
      </Button>
      <ActionMenu
        label={t('bulk.button')}
        title={t('bulk.selected', { count: selectedCount })}
        items={items}
        links={links}
        disabled={selectedCount === 0 || busy}
      />
      <ExportDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        busy={busy}
        labels={{
          title: t('export.title', { count }),
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
            void download(format, null, target === 'selected' ? selection.total : (total ?? 0));
          }
        }}
      />
    </>
  );
}
