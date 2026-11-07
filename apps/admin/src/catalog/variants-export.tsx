'use client';

import { Button, Dialog, Icon, RadioGroup, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { Query } from './products-types.ts';

type ExportFormat = 'csv' | 'xlsx';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** What the request fails with, as the toast words it (one message per cause). */
class ExportFailure extends Error {
  constructor(
    readonly key: 'unavailable' | 'denied' | 'invalid' | 'too-large',
    readonly values: { max: number; total: number } = { max: 0, total: 0 },
  ) {
    super(key);
  }
}

function failureOf(
  status: number,
  code: string,
  details: { max?: number; total?: number } | undefined,
): ExportFailure {
  if (code === 'export.too-large') {
    return new ExportFailure('too-large', { max: details?.max ?? 0, total: details?.total ?? 0 });
  }
  if (status === 401 || status === 403) return new ExportFailure('denied');
  if (code === 'validation.failed') return new ExportFailure('invalid');
  return new ExportFailure('unavailable');
}

/** The list's tab, search and filters as the query of the export (what the Variants file keeps). */
export function variantExportQuery(query: Query, format: ExportFormat): URLSearchParams {
  const params = new URLSearchParams({ format, view: query.view });
  if (query.q.trim() !== '') params.set('q', query.q.trim());
  if (query.filters.scope !== undefined) params.set('scope', query.filters.scope);
  if (query.filters.status !== undefined) params.set('status', query.filters.status);
  if (query.filters.categoryId !== undefined) params.set('categoryId', query.filters.categoryId);
  return params;
}

/**
 * "Export variants" on the product list (catalog design 14b): a CSV or XLSX file with one row per
 * variant of the live version of every product the current tab, search and filters match. A read,
 * so it needs only the view key the page already requires. The server caps the file at 10,000
 * rows and says so when the filter is too wide.
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
          details?: { max?: number; total?: number };
        } | null;
        throw failureOf(response.status, body?.code ?? 'unknown', body?.details);
      }
      const day = new Date().toISOString().slice(0, 10);
      const blob =
        chosen === 'xlsx'
          ? new Blob([await response.arrayBuffer()], { type: XLSX_TYPE })
          : new Blob([await response.text()], { type: 'text/csv;charset=utf-8' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = `variants-${day}.${chosen}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
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
      <Button variant="secondary" className="gap-2" onClick={() => setOpen(true)} disabled={busy}>
        <Icon name="download" />
        {t('button')}
      </Button>
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
