'use client';

import { Badge, toast, type MenuItem, type SuperColumn } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { callApi } from '../api/client.ts';
import { PagedSuperList } from '../shared/paged-list/paged-super-list.tsx';
import type {
  ListPagingMode,
  PagedFilterField,
  PagedListConfig,
} from '../shared/paged-list/types.ts';
import {
  API_VARIANT_TYPES,
  API_VARIANTS,
  ISSUES,
  gtinText,
  localesOf,
  nameOf,
  type IssueCounts,
  type VariantRow,
  type VariantTypeSummary,
} from './types.ts';

export const VARIANT_COLUMNS = {
  fixed: ['variant'],
  optional: ['code', 'gtin', 'sellers', 'issues'],
} as const;

/** The Variants list is read only: open the product, copy the code. */
function useVariantRowActions(): (row: VariantRow) => readonly MenuItem[] {
  const t = useTranslations('variants.list.actions');
  const router = useRouter();
  return useCallback(
    (row) => {
      const items: MenuItem[] = [];
      if (row.actions.includes('open-product')) {
        items.push({
          id: 'open-product',
          label: t('open-product'),
          onSelect: () => router.push(`/catalog/products/${encodeURIComponent(row.productId)}`),
        });
      }
      if (row.actions.includes('copy-code')) {
        items.push({
          id: 'copy-code',
          label: t('copy-code'),
          onSelect: () => {
            navigator.clipboard.writeText(row.variantCode).then(
              () => toast.success(t('copied')),
              () => toast.error(t('copy-failed')),
            );
          },
        });
      }
      return items;
    },
    [t, router],
  );
}

/**
 * The Variants tab as a super list (super list phase 2, list 3): every variant of the Market's
 * live products, newest first, with the ready-made issues as tabs (counts follow the variant type
 * filter), the variant type as a filter, search by product, code, GTIN or SKU, sort, column
 * picker, Export and the row Actions menu (open the product, copy the code).
 */
export function VariantsList({
  paging,
  accountId,
  marketId,
  csrfToken,
}: {
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  /** For saving, renaming, moving and deleting saved filters. */
  readonly csrfToken: string;
}) {
  const t = useTranslations('variants.list');
  const [types, setTypes] = useState<readonly VariantTypeSummary[]>([]);
  const rowActions = useVariantRowActions();

  useEffect(() => {
    void (async () => {
      const result = await callApi<{ items: VariantTypeSummary[] }>('GET', API_VARIANT_TYPES);
      if (result.ok) setTypes(result.body.items);
    })();
  }, []);

  const locale = localesOf(types)[0] ?? 'en';
  const fields: readonly PagedFilterField[] = useMemo(
    () => [
      {
        id: 'typeCode',
        label: t('filter.name.typeCode'),
        options: types.map((type) => ({ value: type.code, label: nameOf(type, locale) })),
      },
    ],
    [t, types, locale],
  );

  const columnDefs = useCallback(
    (id: string, header: string): SuperColumn<VariantRow> => {
      switch (id) {
        case 'variant':
          return {
            id,
            header,
            primary: true,
            cell: (row) => (
              <>
                <a
                  className="font-medium text-link underline wrap-anywhere"
                  href={`/catalog/products/${encodeURIComponent(row.productId)}`}
                >
                  {row.productName ?? row.productCode}
                </a>
                <span className="block text-fg-muted wrap-anywhere">
                  {row.label ?? t('no-label')}
                </span>
                {row.status === 'paused' ? <Badge tone="neutral">{t('paused')}</Badge> : null}
              </>
            ),
          };
        case 'code':
          return {
            id,
            header,
            cell: (row) => <span className="font-mono">{row.variantCode}</span>,
          };
        case 'gtin':
          return {
            id,
            header,
            cell: (row) =>
              row.gtin === null ? (
                <span className="text-fg-muted">—</span>
              ) : (
                <span className="font-mono">{gtinText(row.gtin)}</span>
              ),
          };
        case 'sellers':
          return { id, header, numeric: true, cell: (row) => row.sellers };
        default:
          return {
            id,
            header,
            cell: (row) =>
              row.issues.length === 0 ? (
                <span className="text-fg-muted">—</span>
              ) : (
                <span className="flex flex-wrap gap-1">
                  {row.issues.map((each) => (
                    <Badge key={each} tone={each === 'duplicate-gtin' ? 'critical' : 'attention'}>
                      {t(`tab.${each}`)}
                    </Badge>
                  ))}
                </span>
              ),
          };
      }
    },
    [t],
  );

  const config: PagedListConfig<VariantRow> = useMemo(
    () => ({
      ns: 'variants.list',
      endpoint: API_VARIANTS,
      exportEndpoint: `${API_VARIANTS}/export`,
      exportName: 'variants',
      rowId: (row) => row.variantId,
      rowName: (row) => `${row.productName ?? row.productCode} ${row.variantCode}`,
      tabs: ['all', ...ISSUES],
      tabParam: 'issue',
      search: { max: 100 },
      sorts: [
        {
          id: 'newest',
          orders: [t('sort.newest.first'), t('sort.newest.second')],
          defaultDirection: 'desc',
        },
        { id: 'code', orders: [t('sort.az.first'), t('sort.az.second')], defaultDirection: 'asc' },
        {
          id: 'gtin',
          orders: [t('sort.low.first'), t('sort.low.second')],
          defaultDirection: 'asc',
        },
      ],
      defaultSort: 'newest',
      fixedColumns: VARIANT_COLUMNS.fixed,
      optionalColumns: VARIANT_COLUMNS.optional,
      defaultColumns: VARIANT_COLUMNS.optional,
      columnDefs,
      rowActions,
      icon: 'columns',
      savedKey: 'admin.catalog.variants',
    }),
    [t, columnDefs, rowActions],
  );

  const loadCounts = useCallback(async (filters: Readonly<Record<string, string>>) => {
    const params = new URLSearchParams(
      filters.typeCode === undefined ? {} : { typeCode: filters.typeCode },
    );
    const result = await callApi<IssueCounts>(
      'GET',
      `${API_VARIANTS}/issue-counts${params.size === 0 ? '' : `?${params.toString()}`}`,
    );
    return result.ok ? result.body.counts : null;
  }, []);

  return (
    <PagedSuperList
      config={config}
      paging={paging}
      accountId={accountId}
      marketId={marketId}
      fields={fields}
      loadCounts={loadCounts}
      csrfToken={csrfToken}
    />
  );
}
