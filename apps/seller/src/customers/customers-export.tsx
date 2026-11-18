'use client';

import { Button, ExportDialog, Icon, saveFile, toast, type ExportFormat } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { dayInZone } from '../catalog/products-export.tsx';
import { resolveZone } from '../price/zone-time.ts';
import { numberFormat } from '../shared/intl.ts';
import { selectorOf, type Query } from './query.ts';

/** Codes one export may name; "select all matching" exports by the filter instead (10,000). */
export const EXPORT_CODES_MAX = 1000;
export const EXPORT_PATH = 'customers/seller/customers/export';

const MIME: Record<ExportFormat, string> = {
  csv: 'text/csv;charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** The body of an export: the ticked codes, or the list's own view, search and filters. */
export function exportBody(
  format: ExportFormat,
  query: Query,
  codes: readonly string[] | null,
): Record<string, unknown> {
  return codes === null ? { format, ...selectorOf(query) } : { format, codes };
}

/** What the export request fails with, as the toast words it. */
export function exportFailure(
  status: number,
  code: string,
  details: { readonly max?: number; readonly total?: number } | null,
): { readonly key: string; readonly values: Record<string, number> } {
  if (code === 'batch.too-large') {
    return details?.total === undefined
      ? { key: 'too-many-selected', values: { max: details?.max ?? EXPORT_CODES_MAX } }
      : { key: 'too-large', values: { total: details.total, max: details.max ?? 0 } };
  }
  if (code === 'validation.failed') return { key: 'invalid', values: {} };
  if (status === 401 || status === 403) return { key: 'denied', values: {} };
  return { key: 'unavailable', values: {} };
}

class ExportFailure extends Error {
  constructor(
    readonly key: string,
    readonly values: Record<string, number> = {},
  ) {
    super(key);
  }
}

/**
 * The Export… button of the Customers header and its dialog (CSV or XLSX). The scope is the ticked
 * customers (at most 1,000), or all that match when "select all matching" is on, or, with nothing
 * selected, everything the view, search and filters match (at most 10,000). The file holds codes
 * and first names, never contact details, and the API sends it in the same request.
 */
export function CustomersExport({
  query,
  selectedCodes,
  allMatching,
  total,
  csrfToken,
  timeZone,
  disabled,
}: {
  readonly query: Query;
  readonly selectedCodes: readonly string[];
  readonly allMatching: boolean;
  /** Customers the view, search and filters match; null until the first page loads. */
  readonly total: number | null;
  readonly csrfToken: string;
  readonly timeZone: string | null;
  readonly disabled: boolean;
}) {
  const t = useTranslations('customers.export');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const number = (value: number) => numberFormat(locale, {}).format(value);
  const byCodes = !allMatching && selectedCodes.length > 0;
  const count = byCodes ? selectedCodes.length : (total ?? 0);
  const tooMany = byCodes && selectedCodes.length > EXPORT_CODES_MAX;

  async function download(format: ExportFormat) {
    setBusy(true);
    const work = (async (): Promise<number> => {
      let response: Response;
      try {
        response = await fetch(`/api/${EXPORT_PATH}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: '*/*',
            'x-csrf-token': csrfToken,
          },
          body: JSON.stringify(exportBody(format, query, byCodes ? selectedCodes : null)),
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
        const body = (await response.json().catch((): unknown => null)) as {
          code?: string;
          details?: { max?: number; total?: number };
        } | null;
        const failure = exportFailure(
          response.status,
          body?.code ?? 'unknown',
          body?.details ?? null,
        );
        throw new ExportFailure(failure.key, failure.values);
      }
      const day = dayInZone(new Date(), resolveZone(timeZone));
      saveFile(
        new Blob([await response.arrayBuffer()], { type: MIME[format] }),
        `customers-${day}.${format}`,
      );
      return count;
    })();
    try {
      await toast.promise(
        work,
        {
          pending: t('pending'),
          success: (done) => t('done', { count: done }),
          error: (reason) =>
            reason instanceof ExportFailure
              ? t(`error.${reason.key}`, {
                  max: number(reason.values['max'] ?? 0),
                  total: number(reason.values['total'] ?? 0),
                })
              : t('error.unavailable'),
        },
        { id: 'customers-export' },
      );
    } catch {
      // The toast says what went wrong.
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        className="gap-2"
        disabled={disabled || busy || total === null || total === 0 || tooMany}
        aria-describedby={tooMany ? 'customers-export-hint' : undefined}
        onClick={() => setOpen(true)}
      >
        <Icon name="download" />
        {t('button')}
      </Button>
      {tooMany ? (
        <p id="customers-export-hint" role="status" className="w-full text-sm text-fg-muted">
          {t('too-many-hint', { max: number(EXPORT_CODES_MAX) })}
        </p>
      ) : null}
      <ExportDialog
        open={open}
        onClose={() => setOpen(false)}
        busy={busy}
        labels={{
          title: byCodes
            ? t('title-selected', { count })
            : t('title-matching', { count: number(count) }),
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
          void download(format);
        }}
      />
    </>
  );
}
