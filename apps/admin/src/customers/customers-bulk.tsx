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
import { GroupMembersDialog, type MembersAction } from './group-members-dialog.tsx';
import {
  GROUPS_MANAGE,
  MEMBER_IDS_MAX,
  type CustomerGroup,
  type GroupRef,
} from './groups-types.ts';
import {
  EXPORT_PERMISSION,
  SELECT_MAX,
  selectorOf,
  type OptionalColumn,
  type Query,
} from './list-types.ts';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/**
 * The API takes at most this many ticked ids in one export. More ticked rows are refused here: the
 * list's filter would export every customer it matches, not the ones ticked.
 */
const EXPORT_IDS_MAX = 1000;

/** The export's columns, in the order the API writes them (email is always first). */
const EXPORT_COLUMN: Readonly<Record<OptionalColumn, readonly string[]>> = {
  status: ['status'],
  joined: ['joined'],
  orders: ['orders'],
  spent: ['spent', 'currency'],
  'last-order': ['last-order'],
  verified: ['verified'],
  refunds: ['refunds'],
  groups: ['groups'],
};

export interface CustomersSelection {
  readonly ids: readonly string[];
  readonly allMatching: boolean;
  /** Customers the tab, search and filters match. */
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
 * The Bulk action menu of the Customers list (as the Products list): Export over the ticked rows
 * or, after "Select all N customers", over every customer the list matches; Select all and Clear
 * selection as links. Phase 1 has Export only (add to group and bulk disable come with groups), so
 * an admin without the export key gets no menu at all. Export asks for the format, then the
 * two-step code the API asks for (`customers.customers.export`), then downloads.
 */
export function CustomersBulk({
  selection,
  query,
  columns,
  permissionKeys,
  csrfToken,
  groups = null,
  group = null,
  onSelectAll,
  onClear,
  onMembersChanged = () => undefined,
}: {
  readonly selection: CustomersSelection;
  readonly query: Query;
  readonly columns: readonly OptionalColumn[];
  readonly permissionKeys: readonly string[];
  readonly csrfToken: string;
  /** The Market's groups for Add to group… and Remove from group… (phase 2a). */
  readonly groups?: readonly GroupRef[] | null;
  /** A group page's own group: Remove from this group only. */
  readonly group?: CustomerGroup | null;
  readonly onSelectAll: () => void;
  readonly onClear: () => void;
  readonly onMembersChanged?: () => void;
}) {
  const t = useTranslations('customers.list.bulk');
  const prove = useStepUpProof();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [members, setMembers] = useState<MembersAction | null>(null);
  const count = selection.allMatching ? selection.total : selection.ids.length;
  const canExport = permissionKeys.includes(EXPORT_PERMISSION);
  const canManage = permissionKeys.includes(GROUPS_MANAGE);

  if (!canExport && !canManage) return null;

  const openMembers = (action: MembersAction) => {
    // More ticked rows than the API takes would change every customer the filter matches.
    if (!selection.allMatching && selection.ids.length > MEMBER_IDS_MAX) {
      toast.error(t('error.too-many-ticked-group', { max: MEMBER_IDS_MAX }), {
        id: 'customers-group-members',
      });
      return;
    }
    setMembers(action);
  };

  async function exportFile(format: ExportFormat) {
    if (!selection.allMatching && selection.ids.length > EXPORT_IDS_MAX) {
      toast.error(t('error.too-many-ticked', { max: EXPORT_IDS_MAX }), { id: 'customers-export' });
      return;
    }
    setBusy(true);
    const body = {
      format,
      columns: ['name', ...columns.flatMap((column) => EXPORT_COLUMN[column])],
      ...(selection.allMatching ? selectorOf(query) : { ids: selection.ids }),
    };
    const send = () =>
      fetch('/api/customers/admin/export', {
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
            // Closing the "set up two-step codes" dialog is not a cancelled code.
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
          `customers-${day}.xlsx`,
        );
        return count;
      }
      const text = await response.text();
      saveFile(new Blob([text], { type: 'text/csv;charset=utf-8' }), `customers-${day}.csv`);
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
        { id: 'customers-export' },
      );
    } catch {
      // The toast says what went wrong.
    } finally {
      setBusy(false);
    }
  }

  const items: ActionMenuItem[] = [
    ...(canManage && group === null
      ? [
          {
            id: 'add-to-group',
            label: t('add-to-group'),
            description: t('add-to-group-help'),
            icon: 'plus' as const,
            onSelect: () => openMembers('add'),
          },
        ]
      : []),
    ...(canManage
      ? [
          {
            id: 'remove-from-group',
            label: group === null ? t('remove-from-group') : t('remove-from-this-group'),
            description: t('remove-from-group-help'),
            icon: 'x' as const,
            onSelect: () => openMembers('remove'),
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
  const links = [
    // Select all is offered up to the export's own cap; above it the filter has to be narrowed.
    ...(!selection.allMatching && selection.total > count && selection.total <= SELECT_MAX
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
      <GroupMembersDialog
        action={members}
        count={count}
        groups={groups}
        fixedGroup={
          group === null
            ? null
            : { groupId: group.groupId, name: group.name, archived: group.archived }
        }
        target={selection.allMatching ? { selector: selectorOf(query) } : { ids: selection.ids }}
        csrfToken={csrfToken}
        onClose={() => setMembers(null)}
        onDone={onMembersChanged}
      />
    </>
  );
}
