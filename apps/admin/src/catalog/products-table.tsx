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
import { dayInZone } from '../shared/format.ts';
import { numberFormat } from '../shared/intl.ts';
import type { OptionalColumn, ProductRow, Status } from './products-types.ts';

const TONE: Record<Status, BadgeTone> = {
  published: 'success',
  paused: 'neutral',
  unpublished: 'neutral',
  withdrawn: 'neutral',
  retired: 'neutral',
  matched: 'info',
};

/**
 * The rows of one page, from one column definition (`SuperTable`): a box to select it, image and
 * title (with the code under it), main category, status, then the optional columns the admin chose,
 * and the row Actions menu last. From 1024 px a table; below it each row is a card with labelled
 * lines. A text column starts where its header starts; the Offers count is a number, so its header
 * and cells end together.
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
  readonly timeZone: string;
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

  const content = (column: OptionalColumn, row: ProductRow): ReactNode => {
    switch (column) {
      case 'code':
        return <span className="break-all">{row.productCode}</span>;
      case 'offers':
        return numberFormat(locale, {}).format(row.offerCount);
      case 'updated':
        return (
          <span className="whitespace-nowrap">{dayInZone(row.updatedAt, locale, timeZone)}</span>
        );
      case 'created':
        return (
          <span className="whitespace-nowrap">{dayInZone(row.createdAt, locale, timeZone)}</span>
        );
      case 'type':
        return <span className="break-words">{row.typeCode}</span>;
      case 'scope':
        return t(`scope.${row.scope}`);
      case 'tags': {
        const topics = row.topics ?? [];
        if (topics.length === 0) return <span className="text-fg-muted">{t('tags.none')}</span>;
        const shown = topics.slice(0, 2).map((topic) => {
          const name = topic.name ?? topic.slug;
          return topic.status === 'archived' ? t('tags.archived', { name }) : name;
        });
        const more = topics.length - shown.length;
        return (
          <span className="break-words">
            {shown.join(', ')}
            {more > 0 ? (
              <>
                {' '}
                <span aria-hidden="true">{t('tags.more', { count: more })}</span>
                <span className="sr-only">{t('tags.more-sr', { count: more })}</span>
              </>
            ) : null}
          </span>
        );
      }
      case 'seller':
        return row.scope === 'PLATFORM' ? (
          <span className="text-fg-muted">{t('seller-platform')}</span>
        ) : (
          <span className="break-words">{row.ownerStoreName ?? t('seller-unknown')}</span>
        );
    }
  };

  const defs: SuperColumn<ProductRow>[] = [
    {
      id: 'product',
      header: t('col.product'),
      primary: true,
      skeleton: 'thumb',
      headClassName: 'lg:min-w-72',
      cell: (row) => (
        <div className="flex min-w-0 items-center gap-3">
          {/* The relay serves the photo from the same origin, with the admin session. */}
          <ListThumb
            src={
              row.primaryImageId === null
                ? null
                : `/api/catalog/admin/products/${row.productId}/images/${row.primaryImageId}/thumb`
            }
          />
          <div className="min-w-0">
            <div className="break-words font-medium text-fg">
              {row.name ?? <span className="text-fg-muted">{t('unnamed')}</span>}
            </div>
            <div className="break-words text-xs text-fg-muted">{row.productCode}</div>
          </div>
        </div>
      ),
    },
    {
      id: 'category',
      header: t('col.category'),
      cell: (row) => row.categoryName ?? <span className="text-fg-muted">{t('no-category')}</span>,
    },
    {
      id: 'status',
      header: t('col.status'),
      corner: true,
      cell: (row) => <Badge tone={TONE[row.status]}>{t(`status.${row.status}`)}</Badge>,
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
      rowName={(row) => row.name ?? row.productCode}
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
        columns.length > 4
          ? 'lg:min-w-360'
          : columns.length > 2
            ? 'lg:min-w-300'
            : columns.length > 0
              ? 'lg:min-w-240'
              : 'lg:min-w-160'
      }
    />
  );
}
