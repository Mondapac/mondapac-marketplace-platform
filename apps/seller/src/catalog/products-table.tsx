'use client';

import {
  Badge,
  CARD_TABLE,
  ListRefreshBar,
  ListRefreshHeadRow,
  ListSkeletonRows,
  ListThumb,
  SelectBox,
  type BadgeTone,
  type ListSkeletonCell,
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

// The row's check box: its own column from 1024 px, the card's top corner below it.
const SELECT_CELL =
  'w-14 px-4 py-3 align-middle max-lg:absolute max-lg:start-4 max-lg:top-4 max-lg:w-auto max-lg:p-0';

/** What the table needs to select rows (the Bulk action menu acts on the selection). */
export interface RowSelection {
  readonly selected: ReadonlySet<string>;
  /** "Select all N in this filter" is on: every row of every page counts as selected. */
  readonly allMatching: boolean;
  /** No more rows can be ticked one by one (the cap of one request); ticked ones can be cleared. */
  readonly full: boolean;
  readonly onToggle: (productId: string) => void;
  /** The header box: tick every row of this page, or clear them. */
  readonly onTogglePage: (checked: boolean) => void;
}

/**
 * The rows of one page: a box to select it, photo, name (a link to the product) and, when the Code column is off, the
 * code under it; the status with the Paused and In review badges beside it; the category; then the
 * optional columns the seller chose. From 1024 px a table; below it each row is a card with
 * labelled lines (CARD_TABLE) and the status beside the name. A text column starts where its
 * header starts; the Offers count is a number, so its header and cells end together.
 */
export function ProductsTable({
  rows,
  columns,
  timeZone,
  selection,
  empty,
  skeletonRows,
}: {
  readonly rows: readonly ProductRow[];
  readonly columns: readonly OptionalColumn[];
  /** The seller's own zone, or null when none was chosen (dates then show in UTC). */
  readonly timeZone: string | null;
  readonly selection: RowSelection;
  /** Shown in place of the rows when there are none, under the column headers. */
  readonly empty?: ReactNode;
  /**
   * The first load (panel loading L2): this many skeleton rows in the shape of the visible
   * columns, under the real header, in place of `rows` and `empty`.
   */
  readonly skeletonRows?: number;
}) {
  const t = useTranslations('catalog.products');
  const locale = useLocale();
  const { cell, corner, labelled } = CARD_TABLE;
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
  const numeric = (column: OptionalColumn) => column === 'offers';
  const loading = skeletonRows !== undefined;
  // One placeholder per visible column, with the real cell's classes (CARD_TABLE).
  const skeletonCells: readonly ListSkeletonCell[] = [
    { kind: 'select', className: SELECT_CELL },
    { kind: 'thumb', className: `${cell} lg:min-w-72 max-lg:ps-8` },
    { kind: 'status', className: corner },
    {
      kind: 'text',
      className: `${labelled} lg:min-w-(--mp-size-data-label)`,
      label: t('col.category'),
    },
    ...columns.map((column): ListSkeletonCell => ({
      kind: numeric(column)
        ? 'number'
        : column === 'updated' || column === 'created'
          ? 'date'
          : 'text',
      className: `${labelled} ${numeric(column) ? 'lg:text-end' : ''}`,
      label: t(`col.${column}`),
    })),
  ];
  const isOn = (row: ProductRow) => selection.allMatching || selection.selected.has(row.productId);
  const onPage = rows.filter(isOn).length;
  const allOnPage = rows.length > 0 && onPage === rows.length;
  const someOnPage = onPage > 0 && !allOnPage;

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

  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      {/* The header is hidden below 1024 px, so a phone gets its select-all box in a bar of its own. */}
      {loading || rows.length > 0 ? (
        <label className="relative flex cursor-pointer items-center gap-3 border-b border-line-row bg-muted px-4 py-3 text-sm text-fg-muted lg:hidden">
          <SelectBox
            label={t('select.page-short')}
            checked={allOnPage}
            indeterminate={someOnPage}
            disabled={loading}
            onChange={(event) => selection.onTogglePage(event.target.checked)}
          />
          <span className="ps-1">{t('select.page-short')}</span>
          {/* Cards: the refresh bar runs under this bar, which stands in for the header. */}
          <span className="absolute inset-x-0 top-full">
            <ListRefreshBar />
          </span>
        </label>
      ) : null}
      <table
        className={`${CARD_TABLE.table} ${columns.length > 3 ? 'lg:min-w-240' : columns.length > 1 ? 'lg:min-w-200' : 'lg:min-w-160'}`}
      >
        <caption className="sr-only">{t('title')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            <th scope="col" className="w-14 px-4 py-3 align-middle font-medium">
              <SelectBox
                label={t('select.page')}
                checked={allOnPage}
                indeterminate={someOnPage}
                disabled={loading || rows.length === 0}
                onChange={(event) => selection.onTogglePage(event.target.checked)}
              />
            </th>
            <th scope="col" className="px-4 py-3 font-medium lg:min-w-72">
              {t('col.product')}
            </th>
            <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
              {t('col.status')}
            </th>
            <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
              {t('col.category')}
            </th>
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                className={`whitespace-nowrap px-4 py-3 font-medium ${numeric(column) ? 'text-end' : ''}`}
              >
                {t(`col.${column}`)}
              </th>
            ))}
          </tr>
          <ListRefreshHeadRow columns={4 + columns.length} />
        </thead>
        <tbody className={CARD_TABLE.body}>
          {loading ? <ListSkeletonRows cells={skeletonCells} rows={skeletonRows} /> : null}
          {!loading && rows.length === 0 && empty !== undefined ? (
            <tr className="max-lg:block">
              <td colSpan={4 + columns.length} className="max-lg:block">
                {empty}
              </td>
            </tr>
          ) : null}
          {(loading ? [] : rows).map((row) => {
            const status = known(row.status, PRODUCT_STATUSES);
            const name = row.name ?? row.draftName;
            return (
              <tr
                key={row.productId}
                className={`${CARD_TABLE.row} max-lg:relative ${isOn(row) ? 'bg-selected' : ''}`}
              >
                <td className={SELECT_CELL}>
                  <SelectBox
                    label={t('select.row', { name: name ?? row.productCode })}
                    checked={isOn(row)}
                    disabled={selection.full && !isOn(row)}
                    onChange={() => selection.onToggle(row.productId)}
                  />
                </td>
                <td className={`${cell} lg:min-w-72 max-lg:ps-8`}>
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
                </td>
                {/* On a phone the status sits beside the name, where the eye starts. */}
                <td className={corner}>
                  <div className="flex flex-wrap gap-1 max-lg:justify-end">
                    <Badge tone={TONE[status] ?? 'neutral'}>{t(`status.${status}`)}</Badge>
                    {row.pausedAt === null ? null : <Badge tone="attention">{t('paused')}</Badge>}
                    {row.hasPendingRevision ? <Badge tone="info">{t('in-review')}</Badge> : null}
                  </div>
                </td>
                <td
                  className={`${labelled} lg:min-w-(--mp-size-data-label)`}
                  data-label={t('col.category')}
                >
                  {row.categoryName ?? <span className="text-fg-muted">{t('no-category')}</span>}
                </td>
                {columns.map((column) => (
                  <td
                    key={column}
                    className={`${labelled} ${numeric(column) ? 'lg:text-end lg:tabular-nums' : ''}`}
                    data-label={t(`col.${column}`)}
                  >
                    {content(column, row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
