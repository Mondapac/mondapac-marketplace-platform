'use client';

import {
  Badge,
  ListThumb,
  SuperTable,
  type BadgeTone,
  type MenuItem,
  type RowSelectionState,
  type SuperColumn,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { dateFormat, numberFormat } from '../shared/intl.ts';
import { resolveZone } from '../price/zone-time.ts';
import { known, PRODUCT_STATUSES } from './format.ts';
import type { OptionalColumn, ProductRow } from './products-list-types.ts';

const TONE: Record<string, BadgeTone> = {
  draft: 'neutral',
  unpublished: 'attention',
  published: 'success',
  matched: 'info',
  retired: 'neutral',
  unknown: 'neutral',
};

/**
 * The rows of one page, from one column definition (`SuperTable`): a box to select it, photo, name
 * (a link to the product) and, when the Code column is off, the code under it; the status with the
 * Paused and In review badges beside it; the category; then the optional columns the seller
 * chose; the row Actions menu last. From 1024 px a table; below it each row is a card with
 * labelled lines and the status beside the name. A text column starts where its header starts; the
 * Offers count is a number, so its header and cells end together.
 */
export function ProductsTable({
  rows,
  columns,
  timeZone,
  selection,
  empty,
  skeletonRows,
  actions,
}: {
  readonly rows: readonly ProductRow[];
  readonly columns: readonly OptionalColumn[];
  /** The seller's own zone, or null when none was chosen (dates then show in UTC). */
  readonly timeZone: string | null;
  readonly selection: RowSelectionState;
  /** Shown in place of the rows when there are none, under the column headers. */
  readonly empty?: ReactNode;
  /** The first load (panel loading L2): this many skeleton rows in place of `rows` and `empty`. */
  readonly skeletonRows?: number;
  /** The Actions menu of a row; a row with no items has none. */
  readonly actions: (row: ProductRow) => readonly MenuItem[];
}) {
  const t = useTranslations('catalog.products');
  const locale = useLocale();
  const zone = resolveZone(timeZone);
  const day = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? '-'
      : dateFormat(locale, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          timeZone: zone,
        }).format(date);
  };

  const content = (column: OptionalColumn, row: ProductRow): ReactNode => {
    switch (column) {
      case 'code':
        return <span className="break-all">{row.productCode}</span>;
      case 'offers':
        return numberFormat(locale, {}).format(row.offerCount);
      case 'updated':
        return <span className="whitespace-nowrap">{day(row.lastChangedAt)}</span>;
      case 'created':
        return <span className="whitespace-nowrap">{day(row.createdAt)}</span>;
      case 'type':
        return <span className="break-words">{row.typeCode}</span>;
    }
  };

  const defs: SuperColumn<ProductRow>[] = [
    {
      id: 'product',
      header: t('col.product'),
      primary: true,
      skeleton: 'thumb',
      headClassName: 'lg:min-w-72',
      cell: (row) => {
        const name = row.name ?? row.draftName;
        return (
          <div className="flex min-w-0 items-center gap-3">
            <ListThumb
              src={
                row.primaryImageId === null
                  ? null
                  : `/api/catalog/seller/products/${row.productId}/images/${row.primaryImageId}/thumb`
              }
            />
            <div className="min-w-0">
              <a
                className="break-words font-medium text-link underline"
                href={`/products/${row.productId}`}
              >
                {name ?? t('unnamed')}
              </a>
              {columns.includes('code') ? null : (
                <div className="break-words text-xs text-fg-muted">{row.productCode}</div>
              )}
            </div>
          </div>
        );
      },
    },
    {
      id: 'status',
      header: t('col.status'),
      corner: true,
      cell: (row) => {
        const status = known(row.status, PRODUCT_STATUSES);
        return (
          <div className="flex flex-wrap gap-1 max-lg:justify-end">
            <Badge tone={TONE[status] ?? 'neutral'}>{t(`status.${status}`)}</Badge>
            {row.pausedAt === null ? null : <Badge tone="attention">{t('paused')}</Badge>}
            {row.hasPendingRevision ? <Badge tone="info">{t('in-review')}</Badge> : null}
          </div>
        );
      },
    },
    {
      id: 'category',
      header: t('col.category'),
      cell: (row) => row.categoryName ?? <span className="text-fg-muted">{t('no-category')}</span>,
    },
    ...columns.map((column): SuperColumn<ProductRow> => ({
      id: column,
      header: t(`col.${column}`),
      numeric: column === 'offers',
      skeleton: column === 'updated' || column === 'created' ? 'date' : undefined,
      cell: (row) => content(column, row),
    })),
  ];

  return (
    <SuperTable<ProductRow>
      caption={t('title')}
      rows={rows}
      rowId={(row) => row.productId}
      rowName={(row) => row.name ?? row.draftName ?? row.productCode}
      columns={defs}
      selection={{
        state: selection,
        labels: {
          page: t('select.page'),
          pageShort: t('select.page-short'),
          row: (name) => t('select.row', { name }),
        },
      }}
      actions={{
        header: t('actions.header'),
        label: (name) => t('actions.for', { name }),
        items: actions,
      }}
      empty={empty}
      {...(skeletonRows === undefined ? {} : { skeletonRows })}
      minWidthClass={
        columns.length > 3 ? 'lg:min-w-240' : columns.length > 1 ? 'lg:min-w-200' : 'lg:min-w-160'
      }
    />
  );
}
