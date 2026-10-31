'use client';

import { ActionMenu, Button, Dialog, RadioGroup, toast, type ActionMenuItem } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { numberFormat } from '../shared/intl.ts';
import {
  DELETE_PERMISSION,
  PAUSE_PERMISSION,
  RETIRE_PERMISSION,
  type OptionalColumn,
  type Query,
} from './products-types.ts';

export type BulkAction = 'pause' | 'resume' | 'delete';

/** The file formats of the export. */
type ExportFormat = 'csv' | 'xlsx';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The answer of POST catalog/admin/products/bulk (catalog design 9.2c). */
interface BulkAnswer {
  readonly requested: number;
  readonly eligible: number;
  readonly confirmOfferCount: number;
  readonly affectedOfferCount: number;
  readonly counts: { readonly done: number; readonly skipped: number; readonly failed: number };
  readonly results: readonly {
    readonly productId: string;
    readonly outcome: string;
    readonly reason?: string;
  }[];
}

/** What the request fails with, as the toast words it (one message per cause). */
class BulkFailure extends Error {
  constructor(
    readonly key: string,
    readonly values: Record<string, number> = {},
  ) {
    super(key);
  }
}

/** The rows the menu acts on: the ticked ones, or, after "Select all in this filter", the whole filter. */
export interface BulkSelection {
  readonly ids: readonly string[];
  readonly allMatching: boolean;
  /** Products the current tab, search and filters match. */
  readonly total: number;
}

/** The reasons a product is skipped, in the words of the toast. */
const SKIP_KEYS: Readonly<Record<string, string>> = {
  'product.already-paused': 'already-paused',
  'product.not-paused': 'not-paused',
  'product.not-published': 'not-published',
  'product.not-withdrawable': 'not-withdrawable',
  'product.platform-only': 'not-withdrawable',
  'product.seller-only': 'not-withdrawable',
  'access.denied': 'denied',
};

function bulkFailure(
  status: number,
  code: string,
  details: { max?: number; total?: number; currentCount?: number } | undefined,
): BulkFailure {
  if (code === 'batch.too-large') {
    return new BulkFailure('too-large', { max: details?.max ?? 0, total: details?.total ?? 0 });
  }
  if (code === 'retire.count-changed') {
    return new BulkFailure('count-changed', { count: details?.currentCount ?? 0 });
  }
  if (status === 401 || status === 403) return new BulkFailure('denied');
  if (code === 'validation.failed') return new BulkFailure('invalid');
  return new BulkFailure('unavailable');
}

/**
 * The Bulk action menu of the product list and what it opens (catalog design 9.2c; Figma
 * "Bulk action"): Activate, Deactivate, Export and Delete over the ticked rows or, after "Select
 * all N products in this filter", over every product the filter matches. The button sits with the
 * page's header actions and is disabled until a row is selected; the count shows only in the open
 * menu. Deactivate and Delete ask first (Delete shows how many Offers end, from a dry run, and
 * sends that number back as its confirmation); Export asks for the file format (CSV or XLSX) and then
 * downloads at once; Activate runs at once. Each outcome is a
 * toast with the skipped and failed counts.
 */
export function ProductsBulk({
  selection,
  query,
  columns,
  permissionKeys,
  csrfToken,
  onSelectAll,
  onClear,
  onChanged,
}: {
  readonly selection: BulkSelection;
  readonly query: Query;
  readonly columns: readonly OptionalColumn[];
  readonly permissionKeys: readonly string[];
  readonly csrfToken: string;
  readonly onSelectAll: () => void;
  readonly onClear: () => void;
  /** An action changed products: the list loads again and the selection is cleared. */
  readonly onChanged: () => void;
}) {
  const t = useTranslations('catalog.products.bulk');
  const locale = useLocale();
  const [dialog, setDialog] = useState<'pause' | 'delete' | 'export' | null>(null);
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<
    | { readonly state: 'loading' }
    | { readonly state: 'failed' }
    | { readonly state: 'ready'; readonly answer: BulkAnswer }
  >({ state: 'loading' });
  const cancel = useRef<HTMLButtonElement>(null);

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const count = selection.allMatching ? selection.total : selection.ids.length;
  const canPause = permissionKeys.includes(PAUSE_PERMISSION);
  const canDelete =
    permissionKeys.includes(DELETE_PERMISSION) || permissionKeys.includes(RETIRE_PERMISSION);

  /** Who the request is about: the ticked ids, or the tab and filters as a selector. */
  const target = () => {
    if (!selection.allMatching) return { productIds: selection.ids };
    return {
      selector: {
        view: query.view,
        ...(query.q === '' ? {} : { q: query.q }),
        ...(query.filters.scope === undefined ? {} : { scope: query.filters.scope }),
        ...(query.filters.status === undefined ? {} : { status: query.filters.status }),
        ...(query.filters.categoryId === undefined ? {} : { categoryId: query.filters.categoryId }),
      },
    };
  };

  async function post(
    action: BulkAction,
    extra: Record<string, unknown> = {},
  ): Promise<BulkAnswer> {
    const result = await callApi<BulkAnswer>(
      'POST',
      'catalog/admin/products/bulk',
      { action, ...target(), ...extra },
      csrfToken,
    );
    if (!result.ok) {
      const { failure } = result;
      throw bulkFailure(failure.status, failure.code, failure.details);
    }
    return result.body;
  }

  /** The sentence of an outcome: what was done, then what was skipped and what failed. */
  function summary(action: BulkAction, answer: BulkAnswer): string {
    const { done, skipped, failed } = answer.counts;
    const parts: string[] = [];
    if (done > 0 || (skipped === 0 && failed === 0))
      parts.push(t(`done.${action}`, { count: done }));
    if (skipped > 0) {
      const byReason = new Map<string, number>();
      for (const item of answer.results) {
        if (item.outcome !== 'skipped' || item.reason === undefined) continue;
        const key = SKIP_KEYS[item.reason] ?? 'other';
        byReason.set(key, (byReason.get(key) ?? 0) + 1);
      }
      const reasons = [...byReason].map(([key, n]) => `${number(n)} ${t(`skip.${key}`)}`);
      parts.push(
        reasons.length === 0
          ? t('skipped', { count: skipped })
          : t('skipped-why', { count: skipped, reasons: reasons.join(', ') }),
      );
    }
    if (failed > 0) parts.push(t('failed', { count: failed }));
    return parts.join(' ');
  }

  function failureText(reason: unknown): string {
    if (reason instanceof BulkFailure) {
      return t(`error.${reason.key}`, {
        max: number(reason.values['max'] ?? 0),
        total: number(reason.values['total'] ?? 0),
        count: number(reason.values['count'] ?? 0),
      });
    }
    return t('error.unavailable');
  }

  /** Runs one action with a toast that follows it, then reloads the list. */
  async function run(action: BulkAction, extra: Record<string, unknown> = {}): Promise<boolean> {
    setBusy(true);
    const id = `products-bulk-${action}`;
    const work = post(action, extra);
    void toast.promise(
      work,
      {
        pending: t(`pending.${action}`),
        success: (answer) => summary(action, answer),
        error: failureText,
      },
      { id },
    );
    try {
      const answer = await work;
      // The shared toast shows a finished request as a success: tell the cases that are not.
      if (answer.counts.failed > 0) toast.error(summary(action, answer), { id });
      else if (answer.counts.done === 0) toast.warning(summary(action, answer), { id });
      onChanged();
      return true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function exportFile(chosen: ExportFormat) {
    setBusy(true);
    const params = new URLSearchParams({ format: chosen });
    if (columns.length > 0) params.set('columns', columns.join(','));
    if (selection.allMatching) {
      const { selector } = target() as { selector: Record<string, string> };
      for (const [key, value] of Object.entries(selector)) params.set(key, value);
    } else {
      params.set('ids', selection.ids.join(','));
    }
    const work = (async (): Promise<number> => {
      let response: Response;
      try {
        response = await fetch(`/api/catalog/admin/products/export?${params.toString()}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
      } catch {
        throw new BulkFailure('unavailable');
      }
      if (!response.ok) {
        const body = (await response.json().catch((): unknown => null)) as {
          code?: string;
          details?: { max?: number; total?: number };
        } | null;
        throw bulkFailure(response.status, body?.code ?? 'unknown', body?.details);
      }
      const day = new Date().toISOString().slice(0, 10);
      const save = (blob: Blob, extension: string) => {
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.href = url;
        link.download = `products-${day}.${extension}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      };
      if (chosen === 'xlsx') {
        save(new Blob([await response.arrayBuffer()], { type: XLSX_TYPE }), 'xlsx');
        // The file is a workbook, not text: the count is the number of products asked for.
        return count;
      }
      const text = await response.text();
      save(new Blob([text], { type: 'text/csv;charset=utf-8' }), 'csv');
      // One line of the file per product, after the header.
      return Math.max(
        text
          .replace(/^\uFEFF/, '')
          .split('\r\n')
          .filter((line) => line !== '').length - 1,
        0,
      );
    })();
    try {
      await toast.promise(
        work,
        {
          pending: t('pending.export'),
          success: (rows) => t('done.export', { count: rows }),
          error: failureText,
        },
        { id: 'products-bulk-export' },
      );
    } catch {
      // The toast says what went wrong.
    } finally {
      setBusy(false);
    }
  }

  async function openDelete() {
    setPreview({ state: 'loading' });
    setDialog('delete');
    try {
      setPreview({ state: 'ready', answer: await post('delete', { dryRun: true }) });
    } catch {
      setPreview({ state: 'failed' });
    }
  }

  async function confirmDelete() {
    if (preview.state !== 'ready') return;
    const ok = await run('delete', { confirmOfferCount: preview.answer.confirmOfferCount });
    if (ok) {
      setDialog(null);
      return;
    }
    // The count moved since the dialog opened: show the new one, to be confirmed again.
    await openDelete();
  }

  const items: ActionMenuItem[] = [
    ...(canPause
      ? [
          {
            id: 'resume',
            label: t('menu.resume'),
            icon: 'check' as const,
            onSelect: () => void run('resume'),
          },
          {
            id: 'pause',
            label: t('menu.pause'),
            icon: 'ban' as const,
            onSelect: () => setDialog('pause'),
          },
        ]
      : []),
    {
      id: 'export',
      label: t('menu.export'),
      description: t('menu.export-help'),
      icon: 'download' as const,
      onSelect: () => setDialog('export'),
    },
    ...(canDelete
      ? [
          {
            id: 'delete',
            label: t('menu.delete'),
            icon: 'trash' as const,
            tone: 'critical' as const,
            onSelect: () => void openDelete(),
          },
        ]
      : []),
  ];
  const links = [
    ...(!selection.allMatching && selection.total > count
      ? [
          {
            id: 'select-all',
            label: t('select-all', { count: selection.total }),
            onSelect: onSelectAll,
          },
        ]
      : []),
    { id: 'clear', label: t('clear'), onSelect: onClear },
  ];

  const ready = preview.state === 'ready' ? preview.answer : null;

  return (
    <>
      <ActionMenu
        label={t('button')}
        title={t('selected', { count })}
        items={items}
        links={links}
        disabled={count === 0 || busy}
      />
      <Dialog
        open={dialog === 'pause'}
        title={t('pause.title', { count })}
        onClose={() => setDialog(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              {t('cancel')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setDialog(null);
                void run('pause');
              }}
            >
              {t('pause.confirm')}
            </Button>
          </>
        }
      >
        <p>{t('pause.body')}</p>
      </Dialog>
      <Dialog
        open={dialog === 'export'}
        title={t('export.title', { count })}
        onClose={() => setDialog(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              {t('cancel')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setDialog(null);
                void exportFile(format);
              }}
            >
              {t('export.confirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p>{t('export.body')}</p>
          <RadioGroup
            legend={t('export.legend')}
            name="products-export-format"
            value={format}
            onChange={(next) => setFormat(next === 'xlsx' ? 'xlsx' : 'csv')}
            options={[
              { value: 'csv', label: t('export.csv'), help: t('export.csv-help') },
              { value: 'xlsx', label: t('export.xlsx'), help: t('export.xlsx-help') },
            ]}
          />
        </div>
      </Dialog>
      <Dialog
        open={dialog === 'delete'}
        title={t('delete.title', { count })}
        onClose={() => setDialog(null)}
        initialFocus={cancel}
        actions={
          <>
            <Button ref={cancel} variant="secondary" onClick={() => setDialog(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={ready === null || ready.eligible === 0 || busy}
              onClick={() => void confirmDelete()}
            >
              {t('delete.confirm')}
            </Button>
          </>
        }
      >
        {preview.state === 'failed' ? (
          <p role="alert">{t('error.unavailable')}</p>
        ) : ready === null ? (
          <p>{t('delete.checking')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {ready.eligible === 0 ? (
              <p>{t('delete.none')}</p>
            ) : (
              <p>{t('delete.body', { offers: ready.affectedOfferCount })}</p>
            )}
            {ready.eligible > 0 && ready.eligible < ready.requested ? (
              <p>{t('delete.some-skipped', { count: ready.requested - ready.eligible })}</p>
            ) : null}
          </div>
        )}
      </Dialog>
    </>
  );
}
