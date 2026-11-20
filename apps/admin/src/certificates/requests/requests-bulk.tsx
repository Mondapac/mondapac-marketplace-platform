'use client';

import { ActionMenu, ExportDialog, toast, type ExportFormat } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { ExportFailure, downloadSalesExport } from '../../sales/sales-export.tsx';
import { numberFormat } from '../../shared/intl.ts';
import { API_REQUESTS_EXPORT } from './types.ts';
import {
  exportQuery,
  type ExportSelection,
  type OptionalColumn,
  type Query,
  type QueryContext,
} from './list-types.ts';

/**
 * The Bulk action button of the Issuer requests header. There is no bulk answer (each answer names
 * an issuer or a reason), so its one action is Export: a CSV or XLSX file of the ticked rows or,
 * after "Select all matching", of every request the filter matches, with the columns shown, in the
 * order shown. The button is disabled until a row is selected. The file never holds the seller's
 * typed issuer name. The download and its toast follow the Sales lists' export.
 */
export function RequestsBulk({
  selection,
  query,
  context,
  columns,
}: {
  readonly selection: ExportSelection;
  readonly query: Query;
  readonly context: QueryContext;
  /** The optional columns the admin chose, in the shown order. */
  readonly columns: readonly OptionalColumn[];
}) {
  const t = useTranslations('certificates.requests.bulk');
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
    setBusy(true);
    const work = downloadSalesExport({
      path: API_REQUESTS_EXPORT,
      query: exportQuery({ query, context, format, columns, selection }),
      format,
      fallbackName: 'issuer-requests',
      zone: context.zone,
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
        { id: 'issuer-requests-export' },
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
