'use client';

import {
  ActionMenu,
  ExportDialog,
  saveFile,
  toast,
  type ActionMenuItem,
  type ExportFormat,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ApiFailure } from '../api/client.ts';
import { useStepUpProof } from '../step-up/step-up.tsx';
import {
  ATTRIBUTIONS_EXPORT_PERMISSION,
  ATTRIBUTIONS_MANAGE_PERMISSION,
  DECIDE_MAX,
  EXPORT_IDS_MAX,
  SELECT_MAX,
  attributionSelectorOf,
  type AttributionQuery,
} from './attributions-types.ts';
import type { Decision } from './attributions-decide.tsx';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface AttributionsSelection {
  readonly ids: readonly string[];
  readonly allMatching: boolean;
  /** Rows the view, search and filters match. */
  readonly total: number;
}

class ExportFailure extends Error {
  constructor(
    readonly key: string,
    readonly values: Record<string, number> = {},
  ) {
    super(key);
  }
}

function failureOf(failure: ApiFailure): ExportFailure {
  if (failure.code === 'batch.too-large') {
    return new ExportFailure('too-large', {
      max: failure.details?.max ?? 0,
      total: failure.details?.total ?? 0,
    });
  }
  if (failure.code === 'second-factor.enrolment-required') return new ExportFailure('enrol');
  if (failure.status === 401 || failure.status === 403) return new ExportFailure('denied');
  return new ExportFailure('unavailable');
}

/**
 * The Bulk action menu of the attributions list: Reject… and Restore… (key
 * `customers.seller-attributions.manage`) and Export… (key `customers.customers.export`, behind a
 * fresh two-step code), over the ticked rows or "all matching". An admin with neither key gets no
 * menu. Select all and Clear selection are links.
 */
export function AttributionsBulk({
  selection,
  query,
  permissionKeys,
  csrfToken,
  onDecide,
  onSelectAll,
  onClear,
}: {
  readonly selection: AttributionsSelection;
  readonly query: AttributionQuery;
  readonly permissionKeys: readonly string[];
  readonly csrfToken: string;
  readonly onDecide: (decision: Decision) => void;
  readonly onSelectAll: () => void;
  readonly onClear: () => void;
}) {
  const t = useTranslations('customers.attributions.bulk');
  const prove = useStepUpProof();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const count = selection.allMatching ? selection.total : selection.ids.length;
  const canExport = permissionKeys.includes(ATTRIBUTIONS_EXPORT_PERMISSION);
  const canManage = permissionKeys.includes(ATTRIBUTIONS_MANAGE_PERMISSION);

  if (!canExport && !canManage) return null;

  const decide = (decision: Decision) => {
    // More ticked rows than one request takes are ticked one by one; "all matching" is chunked.
    if (!selection.allMatching && selection.ids.length > DECIDE_MAX) {
      toast.error(t('error.too-many-ticked', { max: DECIDE_MAX }), { id: 'attributions-bulk' });
      return;
    }
    onDecide(decision);
  };

  async function exportFile(format: ExportFormat) {
    if (!selection.allMatching && selection.ids.length > EXPORT_IDS_MAX) {
      toast.error(t('error.too-many-ticked-export', { max: EXPORT_IDS_MAX }), {
        id: 'attributions-export',
      });
      return;
    }
    setBusy(true);
    const body = {
      format,
      ...(selection.allMatching ? attributionSelectorOf(query) : { ids: selection.ids }),
    };
    const send = () =>
      fetch('/api/customers/admin/seller-attributions/export', {
        method: 'POST',
        headers: {
          accept: 'text/csv, application/json',
          'content-type': 'application/json',
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
      });
    const failureFrom = async (response: Response): Promise<ApiFailure> => {
      const parsed = (await response
        .json()
        .catch((): unknown => null)) as Partial<ApiFailure> | null;
      return {
        status: response.status,
        code: typeof parsed?.code === 'string' ? parsed.code : 'unknown',
        ...(parsed?.details === undefined ? {} : { details: parsed.details }),
      };
    };
    const work = (async (): Promise<number> => {
      let response: Response;
      try {
        response = await send();
        if (!response.ok) {
          const failure = await failureFrom(response);
          const proof = await prove(failure, csrfToken);
          if (proof === 'cancelled') {
            throw new ExportFailure(
              failure.code === 'second-factor.enrolment-required' ? 'enrol' : 'cancelled',
            );
          }
          if (proof === 'not-asked') throw failureOf(failure);
          response = await send();
          if (!response.ok) throw failureOf(await failureFrom(response));
        }
      } catch (error) {
        if (error instanceof ExportFailure) throw error;
        throw new ExportFailure('unavailable');
      }
      const day = new Date().toISOString().slice(0, 10);
      if (format === 'xlsx') {
        saveFile(
          new Blob([await response.arrayBuffer()], { type: XLSX_TYPE }),
          `seller-attributions-${day}.xlsx`,
        );
        return count;
      }
      const text = await response.text();
      saveFile(
        new Blob([text], { type: 'text/csv;charset=utf-8' }),
        `seller-attributions-${day}.csv`,
      );
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
          pending: t('pending'),
          success: (rows) => t('done', { count: rows }),
          error: (error: unknown) =>
            error instanceof ExportFailure
              ? error.key === 'cancelled'
                ? t('error.cancelled')
                : t(`error.${error.key}`, error.values)
              : t('error.unavailable'),
        },
        { id: 'attributions-export' },
      );
    } catch {
      // The toast says what went wrong.
    } finally {
      setBusy(false);
    }
  }

  const items: ActionMenuItem[] = [
    ...(canManage
      ? [
          {
            id: 'reject',
            label: t('reject'),
            description: t('reject-help'),
            icon: 'ban' as const,
            tone: 'critical' as const,
            onSelect: () => decide('reject'),
          },
          {
            id: 'restore',
            label: t('restore'),
            description: t('restore-help'),
            icon: 'check' as const,
            onSelect: () => decide('restore'),
          },
        ]
      : []),
    ...(canExport
      ? [
          {
            id: 'export',
            label: t('export'),
            description: t('export-help'),
            icon: 'download' as const,
            onSelect: () => setOpen(true),
          },
        ]
      : []),
  ];
  const offerSelectAll =
    !selection.allMatching && selection.total > count && selection.total <= SELECT_MAX;
  const links = [
    ...(offerSelectAll
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

  return (
    <>
      <ActionMenu
        label={t('button')}
        title={t('selected', { count })}
        items={items}
        links={links}
        disabled={count === 0 || busy}
      />
      <ExportDialog
        open={open}
        onClose={() => setOpen(false)}
        busy={busy}
        labels={{
          title: t('dialog.title', { count }),
          body: t('dialog.body'),
          legend: t('dialog.legend'),
          csv: t('dialog.csv'),
          csvHelp: t('dialog.csv-help'),
          xlsx: t('dialog.xlsx'),
          xlsxHelp: t('dialog.xlsx-help'),
          confirm: t('dialog.confirm'),
          cancel: t('dialog.cancel'),
        }}
        onConfirm={(format) => {
          setOpen(false);
          void exportFile(format);
        }}
      />
    </>
  );
}
