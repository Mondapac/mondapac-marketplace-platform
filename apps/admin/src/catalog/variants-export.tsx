'use client';

import { Button, Dialog, Icon, RadioGroup, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { filterCount, type Query } from './products-types.ts';

type ExportFormat = 'csv' | 'xlsx';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** What the request fails with, as the toast words it (one message per cause). */
class ExportFailure extends Error {
  constructor(
    readonly key: 'unavailable' | 'denied' | 'invalid' | 'too-large',
    readonly values: { max: number } = { max: 0 },
  ) {
    super(key);
  }
}

function failureOf(
  status: number,
  code: string,
  details: { max?: number } | undefined,
): ExportFailure {
  if (code === 'batch.too-large') return new ExportFailure('too-large', { max: details?.max ?? 0 });
  if (status === 401 || status === 403) return new ExportFailure('denied');
  if (code === 'validation.failed') return new ExportFailure('invalid');
  return new ExportFailure('unavailable');
}

/**
 * The query of the export: the list's search text. The variant export takes the Variants tab's
 * filters (`q`, `typeCode` = a variant type, `issue`); the list's tab, scope, status, category and
 * product type are not among them and are not sent.
 */
export function variantExportQuery(query: Query, format: ExportFormat): URLSearchParams {
  const params = new URLSearchParams({ format });
  if (query.q.trim() !== '') params.set('q', query.q.trim());
  return params;
}

/**
 * "Export variants" on the product list (catalog design 14b): a CSV or XLSX file with one row per
 * live variant that the list's search text matches, from the one admin variant export (V6). A
 * read. The server caps the file at 10,000 rows and says so when the search is too wide.
 */
export function VariantsExport({ query }: { readonly query: Query }) {
  const t = useTranslations('catalog.products.variants-export');
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [busy, setBusy] = useState(false);

  async function download(chosen: ExportFormat) {
    setBusy(true);
    const work = (async (): Promise<void> => {
      let response: Response;
      try {
        response = await fetch(
          `/api/catalog/admin/variants/export?${variantExportQuery(query, chosen).toString()}`,
          { credentials: 'same-origin', cache: 'no-store' },
        );
      } catch {
        throw new ExportFailure('unavailable');
      }
      if (!response.ok) {
        const body = (await response.json().catch((): unknown => null)) as {
          code?: string;
          details?: { max?: number };
        } | null;
        throw failureOf(response.status, body?.code ?? 'unknown', body?.details);
      }
      const day = new Date().toISOString().slice(0, 10);
      const blob =
        chosen === 'xlsx'
          ? new Blob([await response.arrayBuffer()], { type: XLSX_TYPE })
          : new Blob([await response.arrayBuffer()], { type: 'text/csv;charset=utf-8' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = `variants-${day}.${chosen}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    })();
    try {
      await toast.promise(
        work,
        {
          pending: t('pending'),
          success: () => t('done'),
          error: (reason: unknown) =>
            reason instanceof ExportFailure
              ? t(`error.${reason.key}`, reason.values)
              : t('error.unavailable'),
        },
        { id: 'variants-export' },
      );
    } catch {
      // The toast says what went wrong.
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-col items-start gap-1">
        <Button variant="secondary" className="gap-2" onClick={() => setOpen(true)} disabled={busy}>
          <Icon name="download" />
          {t('button')}
        </Button>
        {filterCount(query.filters) > 0 ? (
          <p className="text-xs text-fg-muted">{t('filters-note')}</p>
        ) : null}
      </div>
      <Dialog
        open={open}
        title={t('title')}
        onClose={() => setOpen(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setOpen(false);
                void download(format);
              }}
            >
              {t('confirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p>{t('body')}</p>
          <RadioGroup
            legend={t('legend')}
            name="variants-export-format"
            value={format}
            onChange={(next) => setFormat(next === 'xlsx' ? 'xlsx' : 'csv')}
            options={[
              { value: 'csv', label: t('csv'), help: t('csv-help') },
              { value: 'xlsx', label: t('xlsx'), help: t('xlsx-help') },
            ]}
          />
        </div>
      </Dialog>
    </>
  );
}
