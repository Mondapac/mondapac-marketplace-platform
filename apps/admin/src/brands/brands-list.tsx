'use client';

import { Badge, type MenuItem, type SuperColumn } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useMemo } from 'react';
import { callApi } from '../api/client.ts';
import { PagedSuperList } from '../shared/paged-list/paged-super-list.tsx';
import type {
  ListPagingMode,
  PagedAnswer,
  PagedFilterField,
  PagedListConfig,
} from '../shared/paged-list/types.ts';
import { shortId } from '../shared/short-id.ts';
import { When } from '../shared/when.tsx';
import { COUNTRY_CODES } from './country-codes.ts';
import {
  API_BRANDS,
  STATUS_OF,
  type BrandListRow,
  type BrandRow,
  type BrandStatus,
} from './types.ts';

export type RowDialog =
  | { readonly kind: 'form'; readonly brand?: BrandRow }
  | {
      readonly kind: 'confirm';
      readonly action: 'approve' | 'reject' | 'archive';
      readonly brand: BrandRow;
    }
  | { readonly kind: 'merge'; readonly brand: BrandRow };

const LIST_TABS = ['active', 'draft', 'archived'] as const;
const STATUS_TONE: Record<BrandStatus, 'success' | 'attention' | 'neutral'> = {
  active: 'success',
  draft: 'attention',
  archived: 'neutral',
};

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .slice(0, 2)
    .map((word) => (Array.from(word.replace(/[^\p{L}\p{N}]/gu, ''))[0] ?? '').toUpperCase())
    .join('');

/**
 * The brands list as a super list (super list phase 2, list 8): Active, Proposed and Archived as
 * views (Duplicates is the merge queue, beside it), search by name, slug or alias, sort, column
 * picker, selection and the row Actions menu: Approve… (a proposal), Edit…, Merge into this… and
 * Archive… (Turn down… for a proposal), as many as the API names for the row. The page owns the
 * dialogs they open.
 */
export function BrandsList({
  paging,
  accountId,
  marketId,
  onOpen,
  refreshKey,
  headerAction,
  dialogs,
}: {
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  readonly onOpen: (dialog: RowDialog) => void;
  readonly refreshKey: number;
  readonly headerAction: React.ReactNode;
  readonly dialogs: React.ReactNode;
}) {
  const t = useTranslations('brands');
  const tl = useTranslations('brands.list');

  const rowActions = useCallback(
    (row: BrandListRow): readonly MenuItem[] => {
      const can = (id: string) => row.actions.includes(id);
      const items: MenuItem[] = [];
      if (row.status === 'draft' && can('edit')) {
        items.push({
          id: 'approve',
          label: tl('actions.approve'),
          onSelect: () => onOpen({ kind: 'confirm', action: 'approve', brand: row }),
        });
      }
      if (can('edit')) {
        items.push({
          id: 'edit',
          label: tl('actions.edit'),
          onSelect: () => onOpen({ kind: 'form', brand: row }),
        });
      }
      if (can('merge')) {
        items.push({
          id: 'merge',
          label: tl('actions.merge'),
          onSelect: () => onOpen({ kind: 'merge', brand: row }),
        });
      }
      if (can('deactivate')) {
        const proposal = row.status === 'draft';
        items.push({
          id: 'deactivate',
          label: tl(proposal ? 'actions.reject' : 'actions.archive'),
          onSelect: () =>
            onOpen({ kind: 'confirm', action: proposal ? 'reject' : 'archive', brand: row }),
        });
      }
      return items;
    },
    [tl, onOpen],
  );

  const columnDefs = useCallback(
    (id: string, header: string): SuperColumn<BrandListRow> => {
      switch (id) {
        case 'brand':
          return {
            id,
            header,
            primary: true,
            cell: (row) => (
              <div className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-semibold text-fg-muted"
                >
                  {initialsOf(row.name)}
                </span>
                <div className="min-w-0">
                  <p className="font-semibold wrap-anywhere text-fg">{row.name}</p>
                  <p className="text-sm wrap-anywhere text-fg-muted">/brands/{row.slug}</p>
                  {row.status === 'draft' && row.proposedBySellerId !== null ? (
                    <p className="text-sm text-fg-muted">
                      {t('proposed-by')}{' '}
                      <a
                        className="whitespace-nowrap text-link underline"
                        href={`/sellers/${row.proposedBySellerId}`}
                        title={row.proposedBySellerId}
                      >
                        {t('seller-fallback', { id: shortId(row.proposedBySellerId) })}
                      </a>
                    </p>
                  ) : null}
                  {row.status === 'archived' && row.mergedIntoId !== null ? (
                    <p className="text-sm text-fg-muted" title={row.mergedIntoId}>
                      {t('merged-into', { id: shortId(row.mergedIntoId) })}
                    </p>
                  ) : null}
                </div>
              </div>
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
        case 'origin':
          return {
            id,
            header,
            cell: (row) =>
              row.originCountry === null ? (
                <span aria-label={t('not-set')}>{'—'}</span>
              ) : (
                <span>{row.originCountry}</span>
              ),
          };
        default:
          return {
            id,
            header,
            skeleton: 'date',
            cell: (row) => <When iso={row.updatedAt} missing="—" />,
          };
      }
    },
    [t],
  );

  // Origin country: the names are the browser's, in English (the panel is English); the value is the code.
  const fields: readonly PagedFilterField[] = useMemo(() => {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    return [
      {
        id: 'originCountry',
        label: tl('filter.name.originCountry'),
        options: COUNTRY_CODES.map((code) => ({ value: code, label: names.of(code) ?? code })).sort(
          (a, b) => a.label.localeCompare(b.label, 'en'),
        ),
      },
    ];
  }, [tl]);

  const config: PagedListConfig<BrandListRow> = useMemo(
    () => ({
      ns: 'brands.list',
      endpoint: API_BRANDS,
      exportEndpoint: `${API_BRANDS}/export`,
      exportName: 'brands',
      rowId: (row) => row.id,
      rowName: (row) => row.name,
      tabs: LIST_TABS,
      tabParams: (tab) => ({ status: STATUS_OF[tab as (typeof LIST_TABS)[number]] }),
      search: { max: 100 },
      sorts: [
        {
          id: 'name',
          orders: [tl('sort.az.first'), tl('sort.az.second')],
          defaultDirection: 'asc',
        },
        {
          id: 'status',
          orders: [tl('sort.az.first'), tl('sort.az.second')],
          defaultDirection: 'asc',
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
      defaultSort: 'name',
      // The status column is the card's corner on a phone; status is also the tab, so it is optional.
      fixedColumns: ['brand'],
      optionalColumns: ['origin', 'status', 'updated'],
      defaultColumns: ['origin', 'status', 'updated'],
      columnDefs,
      rowActions,
      icon: 'package',
    }),
    [tl, columnDefs, rowActions],
  );

  // The Proposed tab shows how many brands wait (as before: up to 100, then "100+").
  const loadCounts = useCallback(async () => {
    const result = await callApi<PagedAnswer<BrandListRow>>(
      'GET',
      `${API_BRANDS}?status=draft&page=1&pageSize=1&paging=pages`,
    );
    if (!result.ok || result.body.total === null) return null;
    return { draft: result.body.total };
  }, []);

  return (
    <PagedSuperList
      config={config}
      paging={paging}
      accountId={accountId}
      marketId={marketId}
      fields={fields}
      loadCounts={loadCounts}
      refreshKey={refreshKey}
      heading={headerAction}
      dialogs={dialogs}
    />
  );
}
