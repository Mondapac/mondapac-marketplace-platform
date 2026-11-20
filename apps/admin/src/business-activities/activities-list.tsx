'use client';

import { Badge, type MenuItem, type SuperColumn } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useMemo } from 'react';
import { PagedSuperList } from '../shared/paged-list/paged-super-list.tsx';
import type {
  ListPagingMode,
  PagedAnswer,
  PagedFilterField,
  PagedListConfig,
} from '../shared/paged-list/types.ts';
import {
  API_ACTIVITIES,
  type ActivityPage,
  type ActivityRow,
  type ActivityStatus,
  type Locales,
} from './types.ts';

/** A row with what the API names the caller may do on it: `edit`, `deactivate`. */
export type ActivityListRow = ActivityRow & { readonly actions: readonly string[] };
export type ActivityDialog =
  | { readonly kind: 'form'; readonly activity?: ActivityRow }
  | { readonly kind: 'deactivate'; readonly activity: ActivityRow };

const STATUS_TONE: Record<ActivityStatus, 'success' | 'neutral'> = {
  active: 'success',
  inactive: 'neutral',
};

/**
 * The business activities as a super list (super list phase 2, list 9): Active and Inactive as
 * views, search by name or code, sort, column picker, selection, page numbers or Previous and next
 * and the row Actions menu (Edit…, Deactivate…) as the API names them for the row. The page owns
 * the dialogs they open.
 */
export function ActivitiesList({
  paging,
  accountId,
  marketId,
  locale,
  onOpen,
  onLocales,
  refreshKey,
  headerAction,
  dialogs,
}: {
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  /** The Market's default locale (names are shown in it), once the first answer told it. */
  readonly locale: string;
  readonly onOpen: (dialog: ActivityDialog) => void;
  readonly onLocales: (locales: Locales) => void;
  readonly refreshKey: number;
  readonly headerAction: React.ReactNode;
  readonly dialogs: React.ReactNode;
}) {
  const t = useTranslations('business-activities');
  const tl = useTranslations('business-activities.list');
  const nameOf = useCallback((row: ActivityRow): string => row.names[locale] ?? row.code, [locale]);

  const rowActions = useCallback(
    (row: ActivityListRow): readonly MenuItem[] => {
      const items: MenuItem[] = [];
      if (row.actions.includes('edit')) {
        items.push({
          id: 'edit',
          label: tl('actions.edit'),
          onSelect: () => onOpen({ kind: 'form', activity: row }),
        });
      }
      if (row.actions.includes('deactivate')) {
        items.push({
          id: 'deactivate',
          label: tl('actions.deactivate'),
          onSelect: () => onOpen({ kind: 'deactivate', activity: row }),
        });
      }
      return items;
    },
    [tl, onOpen],
  );

  const columnDefs = useCallback(
    (id: string, header: string): SuperColumn<ActivityListRow> => {
      switch (id) {
        case 'name':
          return {
            id,
            header,
            primary: true,
            cell: (row) => (
              <span className="font-semibold wrap-anywhere text-fg">{nameOf(row)}</span>
            ),
          };
        case 'status':
          return {
            id,
            header,
            corner: true,
            cell: (row) => (
              <Badge tone={STATUS_TONE[row.status]}>{t(`status.${row.status}`)}</Badge>
            ),
          };
        case 'code':
          return { id, header, cell: (row) => <span className="wrap-anywhere">{row.code}</span> };
        case 'description':
          return {
            id,
            header,
            cell: (row) =>
              row.description === null ? (
                <span aria-label={t('not-set')}>{'—'}</span>
              ) : (
                <span className="line-clamp-2 wrap-anywhere">{row.description}</span>
              ),
          };
        default:
          return { id, header, numeric: true, cell: (row) => row.categoryIds.length };
      }
    },
    [t, nameOf],
  );

  const config: PagedListConfig<ActivityListRow> = useMemo(
    () => ({
      ns: 'business-activities.list',
      endpoint: API_ACTIVITIES,
      rowId: (row) => row.id,
      rowName: (row) => nameOf(row),
      tabs: ['all', 'active', 'inactive'],
      tabParam: 'status',
      search: { max: 100 },
      sorts: [
        {
          id: 'code',
          orders: [tl('sort.az.first'), tl('sort.az.second')],
          defaultDirection: 'asc',
        },
        {
          id: 'status',
          orders: [tl('sort.az.first'), tl('sort.az.second')],
          defaultDirection: 'desc',
        },
        {
          id: 'created',
          orders: [tl('sort.date.first'), tl('sort.date.second')],
          defaultDirection: 'desc',
        },
        {
          id: 'updated',
          orders: [tl('sort.date.first'), tl('sort.date.second')],
          defaultDirection: 'desc',
        },
      ],
      defaultSort: 'code',
      fixedColumns: ['name'],
      optionalColumns: ['code', 'description', 'categories', 'status'],
      defaultColumns: ['code', 'description', 'categories', 'status'],
      columnDefs,
      rowActions,
      icon: 'package',
    }),
    [tl, columnDefs, rowActions, nameOf],
  );
  const fields: readonly PagedFilterField[] = [];

  return (
    <PagedSuperList
      config={config}
      paging={paging}
      accountId={accountId}
      marketId={marketId}
      fields={fields}
      refreshKey={refreshKey}
      heading={headerAction}
      dialogs={dialogs}
      onAnswer={(answer: PagedAnswer<ActivityListRow>) =>
        onLocales((answer as unknown as ActivityPage).locales)
      }
    />
  );
}
